import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { closeEach, withCleanup } from "./cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import type { StorageFailureCause } from "./errors.js";
import {
	isJournalAdoptError,
	JournalAdoptError,
	type JournalAdoptErrorCode,
	JournalCatalogError,
	JournalShardUnavailableError,
} from "./errors.js";
import {
	isFinishedJournalStatus,
	JournalCatalog,
	type JournalCatalogRunHeader,
	type JournalShardRecord,
	type JournalShardRegistration,
} from "./journal-catalog.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { renderStorageIdentifiers } from "./prefix.js";
import { RUN_JOURNAL_SCHEMA_VERSION } from "./run-journal.js";

/** The journal store's directory under an agent directory: `<agent dir's parent>/workflows/journal`. */
export function defaultJournalStoreDirectory(agentDir: string): string {
	return join(dirname(agentDir), "workflows", "journal");
}

/**
 * The single-file journal every workflow run used by default before the journal store, beside the store's directory.
 * A store opened in `directory` adopts it in place when it holds workflow runs.
 */
export function legacyDefaultJournalPath(directory: string): string {
	return join(dirname(resolve(directory)), "journal.sqlite");
}

/** Most journals one adoption follows through the run references it finds. */
export const JOURNAL_DISCOVERY_LIMIT = 64;
/** The lease holder a consolidation fences a run with while it moves; its successor recognizes an interrupted move. */
export const JOURNAL_CONSOLIDATION_HOLDER_PREFIX = "atomic-storage-consolidate:";

const SQLITE_HEADER = "SQLite format 3\u0000";
const TABLES = renderStorageIdentifiers("journal", { meta: "meta", runs: "runs", events: "events", leases: "leases" });
const POOL_ROOTS = `${TABLES.runs}_pool_roots`;
const LEGACY_RUNS = "runs";
const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** What a journal file holds, read without changing it. */
export interface JournalFileInspection {
	readonly path: string;
	readonly runs: readonly JournalCatalogRunHeader[];
	/** Other node-sqlite journal files its runs say they were written to. */
	readonly references: readonly string[];
}

/** The journal file an adoption path names: the file itself, or `journal.sqlite` in a directory. */
async function adoptionFile(path: string): Promise<string> {
	const absolute = resolve(path);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(absolute);
	} catch (cause) {
		throw new JournalAdoptError({ code: "path-not-found", path: absolute, cause: cause as StorageFailureCause });
	}
	if (!info.isDirectory()) return absolute;
	const inside = join(absolute, "journal.sqlite");
	if (!existsSync(inside)) throw new JournalAdoptError({ code: "not-a-journal", path: absolute, reason: "directory" });
	return inside;
}

async function hasSqliteHeader(path: string): Promise<boolean> {
	const handle = await open(path, "r");
	return withCleanup(
		async () => {
			const buffer = Buffer.alloc(SQLITE_HEADER.length);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return bytesRead === buffer.length && buffer.toString("latin1") === SQLITE_HEADER;
		},
		() => handle.close(),
	);
}

async function tableNames(executor: SqliteExecutor): Promise<ReadonlySet<string>> {
	const rows = await executor.all<SqliteRow & { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
	return new Set(rows.map((row) => row.name));
}

function referencedJournal(headerJson: string, self: string): string | undefined {
	let header: { storage?: { adapter?: unknown; location?: unknown } };
	try {
		header = JSON.parse(headerJson) as typeof header;
	} catch {
		return undefined;
	}
	const location = header.storage?.location;
	if (header.storage?.adapter !== "node-sqlite" || typeof location !== "string") return undefined;
	if (location === "" || location === ":memory:") return undefined;
	const absolute = resolve(location);
	return absolute === self ? undefined : absolute;
}

/**
 * Reads a journal file without changing it: that it is a SQLite workflow journal of a supported schema version, its
 * runs, and the other journal files its runs reference. Throws `JournalAdoptError` for anything that cannot be adopted.
 */
export async function inspectJournalFile(path: string): Promise<JournalFileInspection> {
	const file = await adoptionFile(path);
	let sqlite: boolean;
	try {
		sqlite = await hasSqliteHeader(file);
	} catch (cause) {
		throw new JournalAdoptError({
			code: "not-a-journal",
			path: file,
			reason: "not-sqlite",
			cause: cause as StorageFailureCause,
		});
	}
	if (!sqlite) throw new JournalAdoptError({ code: "not-a-journal", path: file, reason: "not-sqlite" });
	let database: SqliteDatabase;
	try {
		database = await openNodeSqliteDatabase(file, { readOnly: true });
	} catch (cause) {
		throw new JournalAdoptError({
			code: "not-a-journal",
			path: file,
			reason: "not-sqlite",
			cause: cause as StorageFailureCause,
		});
	}
	return withCleanup(
		async () => {
			try {
				const names = await tableNames(database);
				if (names.has("catalog_shards"))
					throw new JournalAdoptError({ code: "not-a-journal", path: file, reason: "store-catalog" });
				const current = names.has(TABLES.meta) && names.has(TABLES.runs);
				const legacy = names.has("meta") && names.has(LEGACY_RUNS) && names.has("events");
				if (!current && !legacy)
					throw new JournalAdoptError({ code: "not-a-journal", path: file, reason: "no-journal-tables" });
				const versions = await database.all<SqliteRow & { schema_version: SqliteValue }>(
					`SELECT schema_version FROM ${current ? TABLES.meta : "meta"}`,
				);
				const found = versions[0]?.schema_version;
				if (versions.length !== 1 || found !== RUN_JOURNAL_SCHEMA_VERSION)
					throw new JournalAdoptError({
						code: "schema-version",
						path: file,
						found: found ?? null,
						supported: RUN_JOURNAL_SCHEMA_VERSION,
					});
				const rows = current
					? await database.all<
							SqliteRow & { run_id: string; name: string; cwd: string; status: string; header_json: string }
						>(`SELECT run_id, name, cwd, status, header_json FROM ${TABLES.runs} ORDER BY run_id`)
					: [];
				const references = new Set<string>();
				for (const row of rows) {
					const referenced = referencedJournal(row.header_json, file);
					if (referenced !== undefined) references.add(referenced);
				}
				return {
					path: file,
					runs: rows.map((row) => ({ runId: row.run_id, name: row.name, cwd: row.cwd, status: row.status })),
					references: [...references],
				};
			} catch (cause) {
				if (cause instanceof JournalAdoptError) throw cause;
				throw new JournalAdoptError({
					code: "not-a-journal",
					path: file,
					reason: "not-sqlite",
					cause: cause as StorageFailureCause,
				});
			}
		},
		() => database.close(),
	);
}

export interface JournalAdoptionOutcome {
	/** The journal file, as an absolute path. */
	readonly path: string;
	readonly status: "adopted" | "already-registered";
	readonly shardId: number;
	/** Runs the catalog indexed from it. */
	readonly runs: number;
}

type DiscoveredJournal =
	| {
			readonly path: string;
			readonly referencedBy: string;
			readonly outcome: "adopted" | "already-registered";
			readonly reason?: undefined;
	  }
	| {
			readonly path: string;
			readonly referencedBy: string;
			readonly outcome: "skipped";
			/** The code of the `JournalAdoptError` adopting it raised. */
			readonly reason: JournalAdoptErrorCode;
	  };

/** A journal found through the runs of an adopted journal, which it names: adopted, or skipped with the reason. */
export type JournalDiscovered = DiscoveredJournal & { readonly checkedAt: number };

export interface JournalAdoptionReport {
	readonly adopted: readonly JournalAdoptionOutcome[];
	/** Journals found through the runs of adopted journals, adopted or skipped with the reason. */
	readonly discovered: readonly JournalDiscovered[];
}

export interface JournalAdoptionOptions {
	/** Follow the journal files the adopted runs reference, adopting each that can be. Default `true`. */
	readonly discover?: boolean;
}

async function withCatalog<T>(store: string | JournalCatalog, body: (catalog: JournalCatalog) => Promise<T>) {
	if (typeof store !== "string") return body(store);
	const catalog = await JournalCatalog.open(store);
	return withCleanup(
		() => body(catalog),
		() => catalog.close(),
	);
}

function adoptionOutcome(
	inspection: JournalFileInspection,
	{ shard, status }: JournalShardRegistration,
): JournalAdoptionOutcome {
	return { path: inspection.path, status, shardId: shard.id, runs: status === "adopted" ? inspection.runs.length : 0 };
}

async function register(catalog: JournalCatalog, inspection: JournalFileInspection): Promise<JournalAdoptionOutcome> {
	return adoptionOutcome(inspection, await catalog.registerAdopted(inspection.path, inspection.runs));
}

/** Follows run references breadth first from `start`, adopting what can be and recording what cannot. */
async function discover(
	catalog: JournalCatalog,
	start: readonly JournalFileInspection[],
): Promise<JournalDiscovered[]> {
	const records: JournalDiscovered[] = [];
	const registered = new Set((await catalog.shards()).map((shard) => resolve(shard.path)));
	const visited = new Set<string>();
	const queue = start.flatMap((inspection) =>
		inspection.references.map((reference) => ({ reference, from: inspection.path })),
	);
	while (queue.length > 0 && visited.size < JOURNAL_DISCOVERY_LIMIT) {
		const { reference, from } = queue.shift()!;
		if (visited.has(reference) || registered.has(reference)) continue;
		visited.add(reference);
		let record: DiscoveredJournal;
		try {
			const inspection = await inspectJournalFile(reference);
			const outcome = await register(catalog, inspection);
			registered.add(inspection.path);
			record = { path: inspection.path, outcome: outcome.status, referencedBy: from };
			for (const next of inspection.references) queue.push({ reference: next, from: inspection.path });
		} catch (error) {
			if (!isJournalAdoptError(error)) throw error;
			record = { path: reference, outcome: "skipped", reason: error.code, referencedBy: from };
		}
		await catalog.recordDiscovery(record);
		records.push({ ...record, checkedAt: Date.now() });
	}
	return records;
}

/**
 * Registers existing journal files in the journal store in place: nothing is copied, each file becomes a shard that
 * keeps the runs it has and takes no new roots, and every run in it resolves through the catalog. Every path is
 * checked first, and all of them are then registered in one catalog transaction: a conflict registers none. Unless
 * `discover: false`, the journals the adopted runs reference are adopted too, and those that cannot be are recorded
 * with the reason.
 */
export async function adoptJournals(
	store: string | JournalCatalog,
	paths: readonly string[],
	options: JournalAdoptionOptions = {},
): Promise<JournalAdoptionReport> {
	return withCatalog(store, async (catalog) => {
		const inspections: JournalFileInspection[] = [];
		for (const path of paths) {
			const inspection = await inspectJournalFile(path);
			if (!inspections.some((earlier) => earlier.path === inspection.path)) inspections.push(inspection);
		}
		const registrations = await catalog.registerAdoptedAll(inspections);
		const adopted = inspections.map((inspection, index) => adoptionOutcome(inspection, registrations[index]!));
		for (const outcome of adopted) await catalog.recordDiscovery({ path: outcome.path, outcome: outcome.status });
		const discovered = options.discover === false ? [] : await discover(catalog, inspections);
		return { adopted, discovered };
	});
}

/**
 * Adopts the legacy default journal beside the store when it holds workflow runs and is not registered yet, then the
 * journals its runs reference. A legacy file that is not a journal (a sessions-only database) is recorded once.
 */
export async function discoverLegacyJournal(
	catalog: JournalCatalog,
	legacyPath: string,
): Promise<JournalAdoptionReport> {
	const path = resolve(legacyPath);
	if (!existsSync(path)) return { adopted: [], discovered: [] };
	if ((await catalog.shards()).some((shard) => resolve(shard.path) === path)) return { adopted: [], discovered: [] };
	let inspection: JournalFileInspection;
	try {
		inspection = await inspectJournalFile(path);
	} catch (error) {
		if (!isJournalAdoptError(error)) throw error;
		const known = (await catalog.discoveries()).find((record) => record.path === path);
		if (known?.outcome !== "skipped" || known.reason !== error.code)
			await catalog.recordDiscovery({ path, outcome: "skipped", reason: error.code });
		return { adopted: [], discovered: [] };
	}
	const outcome = await register(catalog, inspection);
	await catalog.recordDiscovery({ path, outcome: outcome.status });
	return { adopted: [outcome], discovered: await discover(catalog, [inspection]) };
}

export type JournalConsolidationSkip =
	| "unfinished"
	| "leased"
	| "pooled"
	| "legacy-format"
	| "conflict"
	| "changed"
	| "shard-unavailable";

/** One run a consolidation considered: moved from shard `from` to shard `to`, or left where it is with the reason. */
export type JournalConsolidationRun =
	| {
			readonly runId: string;
			readonly from: number;
			readonly to: number;
			readonly outcome: "moved";
			readonly reason?: undefined;
			readonly error?: undefined;
	  }
	| {
			readonly runId: string;
			readonly from: number;
			readonly to?: number;
			readonly outcome: "skipped";
			readonly reason: JournalConsolidationSkip;
			/** The typed error behind `conflict` or `shard-unavailable`. */
			readonly error?: JournalCatalogError | JournalShardUnavailableError;
	  };

export interface JournalConsolidationReport {
	readonly moved: number;
	readonly skipped: number;
	readonly runs: readonly JournalConsolidationRun[];
}

type RunRow = SqliteRow & {
	run_id: string;
	name: string;
	cwd: string;
	created_at: number;
	status: string;
	header_json: string;
};
type EventRow = SqliteRow & {
	run_id: string;
	seq: number;
	epoch: number;
	key: string | null;
	type: string;
	payload: string;
	at: number;
};
type LeaseRow = SqliteRow & { run_id: string; holder_id: string | null; epoch: number; renewed_at: number };

interface FencedRun {
	readonly run: RunRow;
	readonly events: readonly EventRow[];
	readonly lease: LeaseRow;
}

const CONSOLIDATION_TRANSACTION = { lockWaitMs: 10 * 60_000 } as const;

async function openShardFile(record: JournalShardRecord, runId?: string): Promise<SqliteDatabase> {
	if (!existsSync(record.path))
		throw new JournalShardUnavailableError({
			code: "shard-missing",
			shardId: record.id,
			shardPath: record.path,
			runId,
		});
	try {
		return await openNodeSqliteDatabase(record.path);
	} catch (cause) {
		throw new JournalShardUnavailableError({
			code: "shard-open-failed",
			shardId: record.id,
			shardPath: record.path,
			runId,
			cause: cause as StorageFailureCause,
		});
	}
}

/** Whether a journal file has the current journal tables, which a file of only the pre-0.9.38 format does not. */
async function hasJournalTables(database: SqliteExecutor): Promise<boolean> {
	const names = await tableNames(database);
	return [TABLES.runs, TABLES.events, TABLES.leases].every((table) => names.has(table));
}

async function ensureJournalTables(source: SqliteExecutor, target: SqliteExecutor): Promise<void> {
	const definitions = await source.all<SqliteRow & { name: string; sql: string }>(
		`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)`,
		TABLES.meta,
		TABLES.runs,
		TABLES.events,
		TABLES.leases,
	);
	for (const definition of definitions)
		await target.exec(definition.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
	const meta = await target.all(`SELECT schema_version FROM ${TABLES.meta}`);
	if (meta.length === 0) await target.run(`INSERT INTO ${TABLES.meta} VALUES (?)`, RUN_JOURNAL_SCHEMA_VERSION);
}

/**
 * Fences a finished run in its source journal: takes its lease for this consolidation, as a resume would, so no other
 * process can append to it while it moves. Undefined with the reason when it must stay where it is.
 */
async function fence(
	source: SqliteDatabase,
	runId: string,
	holder: string,
): Promise<FencedRun | JournalConsolidationSkip> {
	return source.transaction(async (tx) => {
		const run = await tx.get<RunRow>(`SELECT * FROM ${TABLES.runs} WHERE run_id = ?`, runId);
		const names = await tableNames(tx);
		if (run === undefined) return "legacy-format";
		if (names.has(LEGACY_RUNS) && (await tx.get(`SELECT run_id FROM ${LEGACY_RUNS} WHERE run_id = ?`, runId)))
			return "legacy-format";
		if (!isFinishedJournalStatus(run.status)) return "unfinished";
		if (names.has(POOL_ROOTS) && (await tx.get(`SELECT root FROM ${POOL_ROOTS} WHERE root = ?`, runId)))
			return "pooled";
		const lease = await tx.get<LeaseRow>(`SELECT * FROM ${TABLES.leases} WHERE run_id = ?`, runId);
		const heldByOther =
			lease?.holder_id !== undefined &&
			lease.holder_id !== null &&
			!lease.holder_id.startsWith(JOURNAL_CONSOLIDATION_HOLDER_PREFIX);
		if (heldByOther) return "leased";
		const epoch = Number(lease?.epoch ?? 0) + 1;
		await tx.run(
			`INSERT INTO ${TABLES.leases} VALUES (?, ?, ?, ${STORE_NOW}) ON CONFLICT(run_id) DO UPDATE SET holder_id = excluded.holder_id, epoch = excluded.epoch, renewed_at = excluded.renewed_at`,
			runId,
			holder,
			epoch,
		);
		const events = await tx.all<EventRow>(`SELECT * FROM ${TABLES.events} WHERE run_id = ? ORDER BY seq`, runId);
		const fenced = await tx.get<LeaseRow>(`SELECT * FROM ${TABLES.leases} WHERE run_id = ?`, runId);
		return { run, events, lease: fenced! };
	}, CONSOLIDATION_TRANSACTION);
}

async function unfence(database: SqliteDatabase, runId: string, holder: string): Promise<void> {
	await database.transaction(
		(tx) => tx.run(`UPDATE ${TABLES.leases} SET holder_id = NULL WHERE run_id = ? AND holder_id = ?`, runId, holder),
		CONSOLIDATION_TRANSACTION,
	);
}

function sameRun(left: FencedRun, right: { run: RunRow; events: readonly EventRow[] }): boolean {
	if (left.run.header_json !== right.run.header_json || left.events.length !== right.events.length) return false;
	return left.events.every((event, index) => {
		const other = right.events[index]!;
		return (
			event.seq === other.seq &&
			event.type === other.type &&
			event.payload === other.payload &&
			event.key === other.key
		);
	});
}

/** Copies a fenced run into the target journal in one transaction; false when a different copy is already there. */
async function copy(source: SqliteDatabase, target: SqliteDatabase, fenced: FencedRun): Promise<boolean> {
	return target.transaction(async (tx) => {
		await ensureJournalTables(source, tx);
		const existing = await tx.get<RunRow>(`SELECT * FROM ${TABLES.runs} WHERE run_id = ?`, fenced.run.run_id);
		if (existing !== undefined) {
			const events = await tx.all<EventRow>(
				`SELECT * FROM ${TABLES.events} WHERE run_id = ? ORDER BY seq`,
				fenced.run.run_id,
			);
			if (!sameRun(fenced, { run: existing, events })) return false;
		} else {
			const { run } = fenced;
			await tx.run(
				`INSERT INTO ${TABLES.runs}(run_id, name, cwd, created_at, status, header_json) VALUES (?, ?, ?, ?, ?, ?)`,
				run.run_id,
				run.name,
				run.cwd,
				run.created_at,
				run.status,
				run.header_json,
			);
			for (const event of fenced.events)
				await tx.run(
					`INSERT INTO ${TABLES.events}(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					event.run_id,
					event.seq,
					event.epoch,
					event.key,
					event.type,
					event.payload,
					event.at,
				);
		}
		await tx.run(
			`INSERT INTO ${TABLES.leases} VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET holder_id = excluded.holder_id, epoch = excluded.epoch, renewed_at = excluded.renewed_at`,
			fenced.lease.run_id,
			fenced.lease.holder_id,
			fenced.lease.epoch,
			fenced.lease.renewed_at,
		);
		return true;
	}, CONSOLIDATION_TRANSACTION);
}

/** Deletes the source copy of a moved run, only while this consolidation still holds its fence. */
async function removeSource(source: SqliteDatabase, runId: string, holder: string): Promise<void> {
	await source.transaction(async (tx) => {
		const lease = await tx.get<LeaseRow>(`SELECT * FROM ${TABLES.leases} WHERE run_id = ?`, runId);
		if (lease?.holder_id !== holder) return;
		await tx.run(`DELETE FROM ${TABLES.events} WHERE run_id = ?`, runId);
		await tx.run(`DELETE FROM ${TABLES.runs} WHERE run_id = ?`, runId);
		await tx.run(`DELETE FROM ${TABLES.leases} WHERE run_id = ?`, runId);
	}, CONSOLIDATION_TRANSACTION);
}

/**
 * Moves finished runs out of adopted journals into the store's own shards. A run moves only when it finished
 * (completed, failed or cancelled), no process holds its lease, it never ran local workers (their pool state stays in
 * its journal) and it is not in the pre-0.9.38 table format; every other run stays where it is, with the reason. Each
 * run moves on its own: it is fenced in its journal, copied into a shard in one transaction, repointed in the
 * catalog, and only then deleted from its journal. A consolidation that is interrupted leaves every run readable in
 * exactly one place through the catalog, and running it again finishes the move.
 */
export async function consolidateJournalStore(store: string | JournalCatalog): Promise<JournalConsolidationReport> {
	return withCatalog(store, async (catalog) => {
		const holder = `${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}${randomUUID()}`;
		const results: JournalConsolidationRun[] = [];
		const shards = await catalog.shards();
		const owners = await catalog.owners();
		const targets = new Map<number, SqliteDatabase>();
		const target = async (record: JournalShardRecord): Promise<SqliteDatabase> => {
			let database = targets.get(record.id);
			if (database === undefined) {
				database = await openShardFile(record);
				targets.set(record.id, database);
			}
			return database;
		};
		await withCleanup(
			async () => {
				for (const shard of shards.filter((candidate) => candidate.kind === "adopted")) {
					let source: SqliteDatabase;
					try {
						source = await openShardFile(shard);
					} catch (error) {
						if (!(error instanceof JournalShardUnavailableError)) throw error;
						for (const run of await catalog.runs({ shard: shard.id }))
							results.push({
								runId: run.runId,
								from: shard.id,
								outcome: "skipped",
								reason: "shard-unavailable",
								error,
							});
						continue;
					}
					await withCleanup(
						async () => {
							const legacyOnly = !(await hasJournalTables(source));
							if (!legacyOnly) await finishInterruptedMoves(catalog, source, owners, shard.id, target);
							for (const run of await catalog.runs({ shard: shard.id }))
								results.push(
									legacyOnly
										? { runId: run.runId, from: shard.id, outcome: "skipped", reason: "legacy-format" }
										: await moveOne(catalog, source, shard, run.runId, holder, target),
								);
						},
						() => source.close(),
					);
				}
			},
			() => closeEach(targets.values()),
		);
		const moved = results.filter((run) => run.outcome === "moved").length;
		return { moved, skipped: results.length - moved, runs: results };
	});
}

/**
 * Runs a consolidation that was interrupted had already moved in the catalog: their source copies, still fenced by it,
 * are deleted, and the fence it left on their new shard is lifted.
 */
async function finishInterruptedMoves(
	catalog: JournalCatalog,
	source: SqliteDatabase,
	owners: ReadonlyMap<string, number>,
	shard: number,
	target: (record: JournalShardRecord) => Promise<SqliteDatabase>,
): Promise<void> {
	const fenced = await source.all<LeaseRow>(
		`SELECT * FROM ${TABLES.leases} WHERE holder_id LIKE ?`,
		`${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}%`,
	);
	for (const lease of fenced) {
		const owner = owners.get(lease.run_id);
		if (owner === undefined || owner === shard) continue;
		await removeSource(source, lease.run_id, lease.holder_id!);
		const record = await catalog.shard(owner);
		if (record !== undefined) await unfence(await target(record), lease.run_id, lease.holder_id!);
	}
}

async function moveOne(
	catalog: JournalCatalog,
	source: SqliteDatabase,
	shard: JournalShardRecord,
	runId: string,
	holder: string,
	target: (record: JournalShardRecord) => Promise<SqliteDatabase>,
): Promise<JournalConsolidationRun> {
	const fenced = await fence(source, runId, holder);
	if (typeof fenced === "string") return { runId, from: shard.id, outcome: "skipped", reason: fenced };
	const destination = await catalog.homeShard(runId);
	let database: SqliteDatabase;
	try {
		database = await target(destination);
	} catch (error) {
		await unfence(source, runId, holder);
		if (!(error instanceof JournalShardUnavailableError)) throw error;
		return { runId, from: shard.id, outcome: "skipped", reason: "shard-unavailable", error };
	}
	if (!(await copy(source, database, fenced))) {
		await unfence(source, runId, holder);
		return {
			runId,
			from: shard.id,
			to: destination.id,
			outcome: "skipped",
			reason: "conflict",
			error: new JournalCatalogError({
				code: "run-conflict",
				catalogPath: catalog.path,
				runId,
				shardId: destination.id,
				shardPath: destination.path,
			}),
		};
	}
	if (!(await catalog.moveRun(runId, shard.id, destination.id))) {
		// Another consolidation may have moved the same run to this destination meanwhile: its copy then stays.
		if ((await catalog.locate(runId))?.shard.id === destination.id) {
			await removeSource(source, runId, holder);
			await unfence(database, runId, holder);
		} else {
			await database.transaction(async (tx) => {
				await tx.run(`DELETE FROM ${TABLES.events} WHERE run_id = ?`, runId);
				await tx.run(`DELETE FROM ${TABLES.runs} WHERE run_id = ?`, runId);
				await tx.run(`DELETE FROM ${TABLES.leases} WHERE run_id = ? AND holder_id = ?`, runId, holder);
			}, CONSOLIDATION_TRANSACTION);
			await unfence(source, runId, holder);
		}
		return { runId, from: shard.id, outcome: "skipped", reason: "changed" };
	}
	await removeSource(source, runId, holder);
	await unfence(database, runId, holder);
	return { runId, from: shard.id, to: destination.id, outcome: "moved" };
}
