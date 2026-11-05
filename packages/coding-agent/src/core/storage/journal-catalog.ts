import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { attachCleanupCause } from "./cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import {
	JournalAdoptError,
	type JournalAdoptErrorCode,
	JournalCatalogError,
	type JournalCatalogPhase,
	JournalStoreError,
	type StorageFailureCause,
} from "./errors.js";
import { fileIdentity } from "./file-identity.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

/** The catalog's file in a journal store directory. */
export const JOURNAL_CATALOG_FILE = "catalog.sqlite";
export const JOURNAL_CATALOG_SCHEMA_VERSION = 1;
/** Most shards a store creates for new roots; past it, a new root shares the least busy shard. */
export const JOURNAL_SHARD_LIMIT = 32;
/**
 * A shard reserved for a root that has not been created yet (a pool reserves its root's shard first) counts as busy for
 * this long; a reservation whose run never followed stops holding the shard after it.
 */
export const JOURNAL_RESERVATION_TTL_MS = 10 * 60_000;
/** A catalog write waits out a stalled lock holder as journal writes do: only a lock held with no commit fails it. */
export const JOURNAL_CATALOG_LOCK_WAIT_MS = 10 * 60_000;
/** Statuses with which a root writes continuously, so the shard holding it is under write pressure. */
export const JOURNAL_BUSY_STATUSES = ["running"] as const;
/** Statuses after which a root never writes again unless it is resumed. */
export const JOURNAL_FINISHED_STATUSES = ["completed", "failed", "cancelled"] as const;

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

export type JournalShardKind = "native" | "adopted";

export interface JournalShardRecord {
	readonly id: number;
	/** Absolute path of the shard's SQLite file. */
	readonly path: string;
	readonly kind: JournalShardKind;
	readonly createdAt: number;
	/** Native shards take new roots; an adopted journal only keeps the runs it already had. */
	readonly acceptsNewRoots: boolean;
}

/** A journal file registered as an adopted shard, or found already registered. */
export interface JournalShardRegistration {
	readonly shard: JournalShardRecord;
	readonly status: "adopted" | "already-registered";
}

export interface JournalCatalogRun {
	readonly runId: string;
	readonly shard: number;
	readonly rootRunId: string;
	readonly cwd?: string;
	readonly workflow?: string;
	/** Undefined while the root is only reserved. */
	readonly status?: string;
	readonly updatedAt: number;
}

/** What the catalog records about a run when it is placed or indexed. */
export interface JournalCatalogRunHeader {
	readonly runId: string;
	readonly cwd?: string;
	readonly name?: string;
	readonly status?: string;
}

export type JournalDiscoveryOutcome = "adopted" | "already-registered" | "skipped";

/** One journal the store considered adopting: an explicit path, the legacy default, or a path a run referenced. */
export interface JournalDiscoveryRecord {
	readonly path: string;
	readonly outcome: JournalDiscoveryOutcome;
	/** Why it was skipped: the code of the `JournalAdoptError` adopting it would raise, or `shard-missing`. */
	readonly reason?: JournalAdoptErrorCode;
	/** The journal whose run referenced it; undefined for an explicit or default path. */
	readonly referencedBy?: string;
	readonly checkedAt: number;
}

type ShardRow = SqliteRow & {
	id: number;
	path: string;
	kind: string;
	created_at: number;
	accepts_new_roots: number;
};
type RunRow = SqliteRow & {
	run_id: string;
	shard: number;
	root_run_id: string;
	cwd: string | null;
	workflow: string | null;
	status: string | null;
	updated_at: number;
};

/** FNV-1a: a stable, uniform choice among shards for a run ID, the same in every process. */
export function journalShardHash(runId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < runId.length; index++) {
		hash ^= runId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

export function nativeShardFile(id: number): string {
	return `shard-${String(id).padStart(4, "0")}.sqlite`;
}

/** Whether a status means the run will not write again unless it is resumed. */
export function isFinishedJournalStatus(status: string | undefined): boolean {
	return (JOURNAL_FINISHED_STATUSES as readonly (string | undefined)[]).includes(status);
}

export interface JournalCatalogOptions {
	/**
	 * Creates a new native shard's file, ready for use, before the catalog registers the shard, so no other process
	 * finds the shard before it is ready. By default the file is left empty.
	 */
	readonly prepareShard?: (path: string) => Promise<void>;
}

/**
 * The catalog of a journal store: which shard file holds each root run, and which shard files exist. Its writes are
 * rare (placing a root, recording its status, adopting a journal, moving a finished run), and a run's checkpoints never
 * touch it. Placing a root and adding a shard happen in one catalog transaction, serialized across processes by the
 * catalog's write lock, so concurrent roots see each other.
 */
export class JournalCatalog {
	readonly directory: string;
	readonly path: string;
	private readonly database: SqliteDatabase;
	private readonly prepareShard: (path: string) => Promise<void>;
	private closing?: Promise<void>;

	private constructor(directory: string, database: SqliteDatabase, options: JournalCatalogOptions) {
		this.directory = directory;
		this.path = join(directory, JOURNAL_CATALOG_FILE);
		this.database = database;
		this.prepareShard = options.prepareShard ?? (async () => undefined);
	}

	static async open(directory: string, options: JournalCatalogOptions = {}): Promise<JournalCatalog> {
		const root = resolve(directory);
		const path = join(root, JOURNAL_CATALOG_FILE);
		let database: SqliteDatabase;
		try {
			await mkdir(root, { recursive: true });
			database = await openNodeSqliteDatabase(path);
		} catch (cause) {
			throw new JournalCatalogError({
				code: "catalog-unavailable",
				catalogPath: path,
				phase: "opening",
				cause: cause as StorageFailureCause,
			});
		}
		const catalog = new JournalCatalog(root, database, options);
		try {
			await catalog.write("opening", (tx) => catalog.createSchema(tx));
		} catch (error) {
			const failure =
				error instanceof JournalCatalogError && error.code === "write-failed"
					? new JournalCatalogError({
							code: "catalog-unavailable",
							catalogPath: path,
							phase: "opening",
							cause: error.cause as StorageFailureCause,
						})
					: error;
			await database.close().catch((cleanupCause: unknown) => attachCleanupCause(failure, cleanupCause));
			throw failure;
		}
		return catalog;
	}

	private async createSchema(tx: SqliteExecutor): Promise<void> {
		await tx.exec("CREATE TABLE IF NOT EXISTS catalog_meta(schema_version INTEGER NOT NULL)");
		const versions = await tx.all<SqliteRow & { schema_version: SqliteValue }>(
			"SELECT schema_version FROM catalog_meta",
		);
		if (versions.length > 1)
			throw new JournalCatalogError({
				code: "corrupt",
				catalogPath: this.path,
				rule: `catalog_meta has ${versions.length} rows`,
			});
		if (versions.length === 0) await tx.run("INSERT INTO catalog_meta VALUES (?)", JOURNAL_CATALOG_SCHEMA_VERSION);
		else if (versions[0]!.schema_version !== JOURNAL_CATALOG_SCHEMA_VERSION)
			throw new JournalCatalogError({
				code: "schema-version",
				catalogPath: this.path,
				found: versions[0]!.schema_version,
				supported: JOURNAL_CATALOG_SCHEMA_VERSION,
			});
		await tx.exec(`
			CREATE TABLE IF NOT EXISTS catalog_shards(
				id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL CHECK (kind IN ('native', 'adopted')),
				created_at INTEGER NOT NULL, accepts_new_roots INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS catalog_runs(
				run_id TEXT PRIMARY KEY, shard INTEGER NOT NULL REFERENCES catalog_shards(id),
				root_run_id TEXT NOT NULL, cwd TEXT, workflow TEXT, status TEXT, updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS catalog_runs_shard ON catalog_runs(shard, status);
			CREATE TABLE IF NOT EXISTS catalog_discovery(
				path TEXT PRIMARY KEY, outcome TEXT NOT NULL, reason TEXT, referenced_by TEXT, checked_at INTEGER NOT NULL
			);
		`);
	}

	/** A catalog write transaction; a storage failure becomes a `write-failed` catalog error naming `phase`. */
	private async write<T>(
		phase: JournalCatalogPhase,
		body: (tx: SqliteExecutor) => Promise<T>,
		runId?: string,
	): Promise<T> {
		try {
			return await this.database.transaction(body, { lockWaitMs: JOURNAL_CATALOG_LOCK_WAIT_MS });
		} catch (cause) {
			if (cause instanceof JournalStoreError) throw cause;
			throw new JournalCatalogError({
				code: "write-failed",
				catalogPath: this.path,
				phase,
				runId,
				cause: cause as StorageFailureCause,
			});
		}
	}

	/** A catalog read outside any transaction; a storage failure makes the catalog unavailable. */
	private async read<T>(body: (executor: SqliteExecutor) => Promise<T>): Promise<T> {
		try {
			return await body(this.database);
		} catch (cause) {
			throw new JournalCatalogError({
				code: "catalog-unavailable",
				catalogPath: this.path,
				cause: cause as StorageFailureCause,
			});
		}
	}

	private shardRecord(row: ShardRow): JournalShardRecord {
		const kind = row.kind === "adopted" ? "adopted" : "native";
		return {
			id: Number(row.id),
			path: isAbsolute(row.path) ? row.path : join(this.directory, row.path),
			kind,
			createdAt: Number(row.created_at),
			acceptsNewRoots: Number(row.accepts_new_roots) === 1,
		};
	}

	private runRecord(row: RunRow): JournalCatalogRun {
		return {
			runId: row.run_id,
			shard: Number(row.shard),
			rootRunId: row.root_run_id,
			...(row.cwd === null ? {} : { cwd: row.cwd }),
			...(row.workflow === null ? {} : { workflow: row.workflow }),
			...(row.status === null ? {} : { status: row.status }),
			updatedAt: Number(row.updated_at),
		};
	}

	async shards(): Promise<readonly JournalShardRecord[]> {
		const rows = await this.read((db) => db.all<ShardRow>("SELECT * FROM catalog_shards ORDER BY id"));
		return rows.map((row) => this.shardRecord(row));
	}

	async shard(id: number): Promise<JournalShardRecord | undefined> {
		const row = await this.read((db) => db.get<ShardRow>("SELECT * FROM catalog_shards WHERE id = ?", id));
		return row === undefined ? undefined : this.shardRecord(row);
	}

	async locate(runId: string): Promise<{ run: JournalCatalogRun; shard: JournalShardRecord } | undefined> {
		const row = await this.read((db) =>
			db.get<RunRow & { shard_path: string; kind: string; created_at: number; accepts_new_roots: number }>(
				`SELECT runs.*, shards.path AS shard_path, shards.kind, shards.created_at, shards.accepts_new_roots
				FROM catalog_runs AS runs JOIN catalog_shards AS shards ON shards.id = runs.shard WHERE runs.run_id = ?`,
				runId,
			),
		);
		if (row === undefined) return undefined;
		return {
			run: this.runRecord(row),
			shard: this.shardRecord({ ...row, id: row.shard, path: row.shard_path } as ShardRow),
		};
	}

	/** The roots the catalog counts as running, which keep their shard busy. */
	async busyRuns(): Promise<readonly JournalCatalogRun[]> {
		const rows = await this.read((db) =>
			db.all<RunRow>(
				`SELECT * FROM catalog_runs WHERE status IN (${JOURNAL_BUSY_STATUSES.map(() => "?").join(", ")}) ORDER BY run_id`,
				...JOURNAL_BUSY_STATUSES,
			),
		);
		return rows.map((row) => this.runRecord(row));
	}

	async runs(filter: { readonly shard?: number } = {}): Promise<readonly JournalCatalogRun[]> {
		const rows = await this.read((db) =>
			filter.shard === undefined
				? db.all<RunRow>("SELECT * FROM catalog_runs ORDER BY run_id")
				: db.all<RunRow>("SELECT * FROM catalog_runs WHERE shard = ? ORDER BY run_id", filter.shard),
		);
		return rows.map((row) => this.runRecord(row));
	}

	/** Which shard owns each catalogued run. */
	async owners(): Promise<ReadonlyMap<string, number>> {
		const rows = await this.read((db) =>
			db.all<SqliteRow & { run_id: string; shard: number }>("SELECT run_id, shard FROM catalog_runs"),
		);
		return new Map(rows.map((row) => [row.run_id, Number(row.shard)]));
	}

	/**
	 * The shard of `header.runId`, placing it when the catalog does not know it yet. A new root goes to an idle shard
	 * that accepts new roots (one holding no running or freshly reserved root), chosen among them by the hash of its ID;
	 * when every such shard is busy a new shard is added, up to `JOURNAL_SHARD_LIMIT`, and past that the root shares the
	 * least busy one. A placed run never moves to another shard while it can still write.
	 */
	async place(
		header: JournalCatalogRunHeader,
	): Promise<{ shard: JournalShardRecord; placed: boolean; status: string | undefined }> {
		return this.write(
			"placing-run",
			async (tx) => {
				const existing = await tx.get<RunRow>("SELECT * FROM catalog_runs WHERE run_id = ?", header.runId);
				if (existing !== undefined) {
					if (existing.status === null && header.status !== undefined)
						await tx.run(
							`UPDATE catalog_runs SET cwd = COALESCE(cwd, ?), workflow = COALESCE(workflow, ?), status = ?, updated_at = ${STORE_NOW} WHERE run_id = ?`,
							header.cwd ?? null,
							header.name ?? null,
							header.status,
							header.runId,
						);
					const row = await tx.get<ShardRow>("SELECT * FROM catalog_shards WHERE id = ?", existing.shard);
					if (row === undefined)
						throw new JournalCatalogError({
							code: "corrupt",
							catalogPath: this.path,
							runId: header.runId,
							shardId: Number(existing.shard),
							rule: `run ${header.runId} names shard ${existing.shard}, which is not registered`,
						});
					return {
						shard: this.shardRecord(row),
						placed: false,
						status: existing.status === null ? header.status : existing.status,
					};
				}
				const shard = await this.choose(tx, header.runId);
				await tx.run(
					`INSERT INTO catalog_runs(run_id, shard, root_run_id, cwd, workflow, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW})`,
					header.runId,
					shard.id,
					header.runId,
					header.cwd ?? null,
					header.name ?? null,
					header.status ?? null,
				);
				return { shard, placed: true, status: header.status };
			},
			header.runId,
		);
	}

	/**
	 * The shards a new root can go to. A native shard whose file is gone was lost: it stops taking new roots here, and
	 * its registered runs stay where they are and keep failing with `shard-missing` until the file is restored.
	 */
	private async acceptingShards(tx: SqliteExecutor): Promise<JournalShardRecord[]> {
		const accepting: JournalShardRecord[] = [];
		for (const row of await tx.all<ShardRow>(
			"SELECT * FROM catalog_shards WHERE accepts_new_roots = 1 ORDER BY id",
		)) {
			const shard = this.shardRecord(row);
			if (existsSync(shard.path)) accepting.push(shard);
			else await tx.run("UPDATE catalog_shards SET accepts_new_roots = 0 WHERE id = ?", shard.id);
		}
		return accepting;
	}

	private async choose(tx: SqliteExecutor, runId: string): Promise<JournalShardRecord> {
		const accepting = await this.acceptingShards(tx);
		const busyRows = await tx.all<SqliteRow & { shard: number; busy: number }>(
			`SELECT shard, count(*) AS busy FROM catalog_runs
			WHERE status IN (${JOURNAL_BUSY_STATUSES.map(() => "?").join(", ")})
				OR (status IS NULL AND updated_at >= ${STORE_NOW} - ?)
			GROUP BY shard`,
			...JOURNAL_BUSY_STATUSES,
			JOURNAL_RESERVATION_TTL_MS,
		);
		const busy = new Map(busyRows.map((row) => [Number(row.shard), Number(row.busy)]));
		const load = (shard: JournalShardRecord) => busy.get(shard.id) ?? 0;
		const pick = (candidates: readonly JournalShardRecord[]) =>
			candidates[journalShardHash(runId) % candidates.length]!;
		const idle = accepting.filter((shard) => load(shard) === 0);
		if (idle.length > 0) return pick(idle);
		if (accepting.length < JOURNAL_SHARD_LIMIT) {
			const next = await tx.get<SqliteRow & { next: number }>(
				"SELECT COALESCE(MAX(id), 0) + 1 AS next FROM catalog_shards",
			);
			return this.addNativeShard(tx, Number(next!.next));
		}
		const least = Math.min(...accepting.map(load));
		return pick(accepting.filter((shard) => load(shard) === least));
	}

	/**
	 * Registers a native shard with its file created and prepared first, so a native shard whose file is missing was
	 * lost. The file is always new: a name that already exists, or that a registered shard already names even if its file is
	 * gone, such as an adopted journal living in the store's directory, is skipped and never taken by a shard of its own.
	 */
	private async addNativeShard(tx: SqliteExecutor, id: number): Promise<JournalShardRecord> {
		const file = await this.createNativeShardFile(tx, id);
		await this.prepareShard(join(this.directory, file));
		await tx.run(
			`INSERT INTO catalog_shards(id, path, kind, created_at, accepts_new_roots) VALUES (?, ?, 'native', ${STORE_NOW}, 1)`,
			id,
			file,
		);
		const row = await tx.get<ShardRow>("SELECT * FROM catalog_shards WHERE id = ?", id);
		return this.shardRecord(row!);
	}

	private async createNativeShardFile(tx: SqliteExecutor, from: number): Promise<string> {
		const registered = new Set(
			(await tx.all<ShardRow>("SELECT * FROM catalog_shards")).map((row) => this.shardRecord(row).path),
		);
		for (let number = from; ; number++) {
			const file = nativeShardFile(number);
			if (registered.has(join(this.directory, file))) continue;
			try {
				await (await open(join(this.directory, file), "wx")).close();
				return file;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
			}
		}
	}

	/**
	 * The shard a run ID hashes to among the shards that accept new roots, adding the first shard when there is none:
	 * where a consolidation moves a finished run, which never makes a shard busy.
	 */
	async homeShard(runId: string): Promise<JournalShardRecord> {
		return this.write(
			"moving-run",
			async (tx) => {
				const accepting = await this.acceptingShards(tx);
				if (accepting.length > 0) return accepting[journalShardHash(runId) % accepting.length]!;
				const next = await tx.get<SqliteRow & { next: number }>(
					"SELECT COALESCE(MAX(id), 0) + 1 AS next FROM catalog_shards",
				);
				return this.addNativeShard(tx, Number(next!.next));
			},
			runId,
		);
	}

	/** Records a root's latest status, which decides whether its shard counts as busy. */
	async setStatus(runId: string, status: string): Promise<void> {
		await this.write(
			"recording-status",
			(tx) =>
				tx.run(`UPDATE catalog_runs SET status = ?, updated_at = ${STORE_NOW} WHERE run_id = ?`, status, runId),
			runId,
		);
	}

	/**
	 * Records a status a shard saved for a root, only while the catalog's entry is still the one that was read: the same
	 * status and the same update time, so a status recorded since, by a resume for instance, is not written over.
	 * Whether it was recorded.
	 */
	async reconcileStatus(run: JournalCatalogRun, status: string): Promise<boolean> {
		const result = await this.write(
			"recording-status",
			(tx) =>
				tx.run(
					`UPDATE catalog_runs SET status = ?, updated_at = ${STORE_NOW} WHERE run_id = ? AND status = ? AND updated_at = ?`,
					status,
					run.runId,
					run.status ?? null,
					run.updatedAt,
				),
			run.runId,
		);
		return result.changes === 1;
	}

	async remove(runId: string): Promise<void> {
		await this.write("removing-run", (tx) => tx.run("DELETE FROM catalog_runs WHERE run_id = ?", runId), runId);
	}

	/** Removes a run's catalog entry only while it is still on `shard`; whether it was removed. */
	async removeFrom(runId: string, shard: number): Promise<boolean> {
		const result = await this.write(
			"removing-run",
			(tx) => tx.run("DELETE FROM catalog_runs WHERE run_id = ? AND shard = ?", runId, shard),
			runId,
		);
		return result.changes === 1;
	}

	/** Moves a run's catalog entry from `from` to `to`, only if it is still on `from`; whether it moved. */
	async moveRun(runId: string, from: number, to: number): Promise<boolean> {
		const result = await this.write(
			"moving-run",
			(tx) =>
				tx.run(
					`UPDATE catalog_runs SET shard = ?, updated_at = ${STORE_NOW} WHERE run_id = ? AND shard = ?`,
					to,
					runId,
					from,
				),
			runId,
		);
		return result.changes === 1;
	}

	/** Indexes a run found in a registered shard that the catalog did not list yet (written there by another process). */
	async index(shard: number, header: JournalCatalogRunHeader): Promise<number> {
		return this.write(
			"registering-shard",
			async (tx) => {
				await tx.run(
					`INSERT INTO catalog_runs(run_id, shard, root_run_id, cwd, workflow, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW}) ON CONFLICT(run_id) DO NOTHING`,
					header.runId,
					shard,
					header.runId,
					header.cwd ?? null,
					header.name ?? null,
					header.status ?? null,
				);
				const row = await tx.get<SqliteRow & { shard: number }>(
					"SELECT shard FROM catalog_runs WHERE run_id = ?",
					header.runId,
				);
				return Number(row!.shard);
			},
			header.runId,
		);
	}

	/**
	 * Registers an existing journal file in place as an adopted shard and indexes its runs, in one transaction: either
	 * the shard and every run are registered, or nothing is. A run the store already has elsewhere fails the whole
	 * adoption with `run-conflict`. A path already registered is left as it is.
	 */
	async registerAdopted(path: string, runs: readonly JournalCatalogRunHeader[]): Promise<JournalShardRegistration> {
		return (await this.registerAdoptedAll([{ path, runs }]))[0]!;
	}

	/** Registers several journal files as `registerAdopted` does, all in one transaction: every file, or none. */
	async registerAdoptedAll(
		files: readonly { readonly path: string; readonly runs: readonly JournalCatalogRunHeader[] }[],
	): Promise<JournalShardRegistration[]> {
		return this.write("registering-shard", async (tx) => {
			const registrations: JournalShardRegistration[] = [];
			for (const file of files) registrations.push(await this.registerIn(tx, resolve(file.path), file.runs));
			return registrations;
		});
	}

	private async registerIn(
		tx: SqliteExecutor,
		absolute: string,
		runs: readonly JournalCatalogRunHeader[],
	): Promise<JournalShardRegistration> {
		const identity = fileIdentity(absolute);
		const registered = (await tx.all<ShardRow>("SELECT * FROM catalog_shards"))
			.map((row) => this.shardRecord(row))
			.find((shard) => shard.path === absolute || (identity !== undefined && fileIdentity(shard.path) === identity));
		if (registered !== undefined) return { shard: registered, status: "already-registered" };
		for (const run of runs) {
			const existing = await tx.get<RunRow & { shard_path: string }>(
				"SELECT runs.*, shards.path AS shard_path FROM catalog_runs AS runs JOIN catalog_shards AS shards ON shards.id = runs.shard WHERE runs.run_id = ?",
				run.runId,
			);
			if (existing !== undefined)
				throw new JournalAdoptError({
					code: "run-conflict",
					path: absolute,
					runId: run.runId,
					existingPath: isAbsolute(existing.shard_path)
						? existing.shard_path
						: join(this.directory, existing.shard_path),
				});
		}
		const next = await tx.get<SqliteRow & { next: number }>(
			"SELECT COALESCE(MAX(id), 0) + 1 AS next FROM catalog_shards",
		);
		const id = Number(next!.next);
		await tx.run(
			`INSERT INTO catalog_shards(id, path, kind, created_at, accepts_new_roots) VALUES (?, ?, 'adopted', ${STORE_NOW}, 0)`,
			id,
			absolute,
		);
		for (const run of runs)
			await tx.run(
				`INSERT INTO catalog_runs(run_id, shard, root_run_id, cwd, workflow, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${STORE_NOW})`,
				run.runId,
				id,
				run.runId,
				run.cwd ?? null,
				run.name ?? null,
				run.status ?? null,
			);
		const row = await tx.get<ShardRow>("SELECT * FROM catalog_shards WHERE id = ?", id);
		return { shard: this.shardRecord(row!), status: "adopted" };
	}

	async recordDiscovery(record: Omit<JournalDiscoveryRecord, "checkedAt">): Promise<void> {
		await this.write("registering-shard", (tx) =>
			tx.run(
				`INSERT INTO catalog_discovery(path, outcome, reason, referenced_by, checked_at) VALUES (?, ?, ?, ?, ${STORE_NOW})
				ON CONFLICT(path) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason,
					referenced_by = COALESCE(excluded.referenced_by, catalog_discovery.referenced_by), checked_at = excluded.checked_at`,
				resolve(record.path),
				record.outcome,
				record.reason ?? null,
				record.referencedBy ?? null,
			),
		);
	}

	async discoveries(): Promise<readonly JournalDiscoveryRecord[]> {
		const rows = await this.read((db) =>
			db.all<
				SqliteRow & {
					path: string;
					outcome: string;
					reason: string | null;
					referenced_by: string | null;
					checked_at: number;
				}
			>("SELECT * FROM catalog_discovery ORDER BY path"),
		);
		return rows.map((row) => ({
			path: row.path,
			outcome: row.outcome as JournalDiscoveryOutcome,
			...(row.reason === null ? {} : { reason: row.reason as JournalAdoptErrorCode }),
			...(row.referenced_by === null ? {} : { referencedBy: row.referenced_by }),
			checkedAt: Number(row.checked_at),
		}));
	}

	/** Moves whenever any connection commits a change to the catalog. */
	async changeToken(): Promise<string> {
		const row = await this.read((db) =>
			db.get<SqliteRow>(
				`SELECT data_version, total_changes() AS changes,
					(SELECT count(*) FROM catalog_runs) AS runs, (SELECT count(*) FROM catalog_shards) AS shards,
					(SELECT max(updated_at) FROM catalog_runs) AS updated
				FROM pragma_data_version`,
			),
		);
		return JSON.stringify(Object.values(row ?? {}).map(String));
	}

	close(): Promise<void> {
		this.closing ??= this.database.close();
		return this.closing;
	}
}
