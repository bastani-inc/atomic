/**
 * Workflow runs as versioned JSONL files (#4716, #4720): `exportWorkflowRuns` writes each run of a local workflow
 * journal to `<dir>/<runId>.jsonl`, and the import functions restore such files into one. The journal stays the
 * working store; the files are the form runs take at rest, so a host that persists only files can carry them between
 * machines. `atomic storage export` and `import` use `<exportDir>/workflows` as `<dir>`.
 *
 * Line 1 of a file is the run's header: the row of the journal's runs table. Every later line is one row of its
 * events table, in sequence order, with its payload as a JSON value instead of JSON text. Leases, local-worker pool
 * state and worktree snapshot blobs are not exported: they belong to the machine that wrote them.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { closeEach, withCleanup } from "./cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import type { StorageFailureCause } from "./errors.js";
import {
	discoverLegacyJournal,
	ensureRunJournalSchema,
	type JournalEventTableRow,
	type JournalLeaseTableRow,
	type JournalRunTableRow,
	legacyDefaultJournalPath,
	runJournalTables,
} from "./journal-adoption.js";
import {
	isFinishedJournalStatus,
	JOURNAL_CATALOG_FILE,
	JournalCatalog,
	type JournalCatalogRun,
	type JournalShardRecord,
} from "./journal-catalog.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { RUN_EVENT_TYPES, RUN_JOURNAL_SCHEMA_VERSION } from "./run-journal.js";
import {
	readTransferDirectory,
	StorageImportIncompleteError,
	StorageTransferError,
	type TransferFileLines,
	transferFile,
	writeLinesAtomically,
} from "./transfer-files.js";

/** The `type` of an export file's header line. */
export const WORKFLOW_RUN_EXPORT_TYPE = "atomic.workflow-run";
/** The export format version this Atomic writes and reads. */
export const WORKFLOW_RUN_EXPORT_VERSION = 1;
/**
 * A lease renewed this recently belongs to a process that may still be running the run on this machine, so an import
 * does not add events to that run. It matches the window in which the workflows runtime treats a running run's owner
 * as live.
 */
export const WORKFLOW_RUN_IMPORT_LIVE_LEASE_MS = 120_000;
/**
 * How many times an export reads the catalog again after reading the journal files, for runs a consolidation moved
 * in between; a run still not found where the catalog names it after the last read is reported with its reason.
 */
export const WORKFLOW_RUN_EXPORT_PLACEMENT_ATTEMPTS = 5;

/** A JSON value as an export file holds it. */
export type WorkflowRunExportValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkflowRunExportValue[]
	| { readonly [key: string]: WorkflowRunExportValue };

/** Line 1 of an export file. */
export interface WorkflowRunExportHeader {
	readonly type: typeof WORKFLOW_RUN_EXPORT_TYPE;
	readonly version: typeof WORKFLOW_RUN_EXPORT_VERSION;
	readonly runId: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;
	/** The run's latest status. */
	readonly status: string;
	/** How many event lines follow. */
	readonly events: number;
	/** The run header the journal recorded when the run was created. */
	readonly header: { readonly [key: string]: WorkflowRunExportValue };
}

/** One event line of an export file: one journal entry. */
export interface WorkflowRunExportEvent {
	readonly type: string;
	readonly seq: number;
	readonly epoch: number;
	readonly key: string | null;
	readonly at: number;
	readonly payload: WorkflowRunExportValue;
}

/** The local workflow journal storage that runs are exported from and imported into. */
export type WorkflowRunTransferStorage =
	| { readonly kind: "store"; readonly directory: string }
	| { readonly kind: "sqlite"; readonly path: string; readonly prefix?: string };

export interface WorkflowRunExportOptions {
	/** Only these runs; a run the storage does not hold fails the export before any file is written. */
	readonly runs?: readonly string[];
	/** Only runs that are not completed, failed or cancelled. */
	readonly unfinished?: boolean;
	/** At most this many runs, newest first. */
	readonly limit?: number;
}

export interface WorkflowRunExportReport {
	/** Runs whose file was written. */
	readonly written: readonly string[];
	/** Runs whose file already held exactly this export, left untouched. */
	readonly unchanged: readonly string[];
	/** Journal files that could not be read, and catalogued runs that could not be exported, with the reason. */
	readonly skipped: readonly { readonly path: string; readonly runId?: string; readonly reason: string }[];
}

export interface WorkflowRunImportReport {
	/** Runs the storage did not hold. */
	readonly added: readonly string[];
	/** Runs the storage held an earlier part of, which now have the file's later events. */
	readonly updated: readonly string[];
	/** Runs the storage already held every event of. */
	readonly unchanged: readonly string[];
}

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const TRANSFER_TRANSACTION = { lockWaitMs: 10 * 60_000 } as const;
const EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(RUN_EVENT_TYPES));
const HEADER_FIELDS = ["type", "version", "runId", "name", "cwd", "createdAt", "status", "events", "header"] as const;
const EVENT_FIELDS = ["type", "seq", "epoch", "key", "at", "payload"] as const;
/** The runs table of the journal format before 0.9.38, which an export cannot read. */
const LEGACY_RUNS_TABLE = "runs";
const OLD_FORMAT_REASON = "it is in the journal format of Atomic before 0.9.38; resume it once to convert it";

type JsonObject = { readonly [key: string]: WorkflowRunExportValue };
type Tables = ReturnType<typeof runJournalTables>;

function storageLocation(storage: WorkflowRunTransferStorage): string {
	return storage.kind === "store" ? storage.directory : storage.path;
}

function parseStored(text: string, path: string, runId: string, what: string): WorkflowRunExportValue {
	try {
		return JSON.parse(text) as WorkflowRunExportValue;
	} catch (cause) {
		throw new StorageTransferError({
			path,
			id: runId,
			reason: `run ${runId} has ${what} that is not valid JSON`,
			cause: cause as StorageFailureCause,
		});
	}
}

/** A run and its events as the lines of its export file. */
function exportLines(run: JournalRunTableRow, events: readonly JournalEventTableRow[], path: string): string[] {
	const header = parseStored(run.header_json, path, run.run_id, "a header");
	if (!isObject(header))
		throw new StorageTransferError({
			path,
			id: run.run_id,
			reason: `run ${run.run_id} has a header that is not an object`,
		});
	const lines = [
		JSON.stringify({
			type: WORKFLOW_RUN_EXPORT_TYPE,
			version: WORKFLOW_RUN_EXPORT_VERSION,
			runId: run.run_id,
			name: run.name,
			cwd: run.cwd,
			createdAt: Number(run.created_at),
			status: run.status,
			events: events.length,
			header,
		} satisfies WorkflowRunExportHeader),
	];
	for (const event of events)
		lines.push(
			JSON.stringify({
				type: event.type,
				seq: Number(event.seq),
				epoch: Number(event.epoch),
				key: event.key,
				at: Number(event.at),
				payload: parseStored(event.payload, path, run.run_id, `event ${event.seq} with a payload`),
			} satisfies WorkflowRunExportEvent),
		);
	return lines;
}

async function hasTables(executor: SqliteExecutor, t: Tables): Promise<boolean> {
	const rows = await executor.all<SqliteRow & { name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
		t.meta,
		t.runs,
		t.events,
	);
	return rows.length === 3;
}

async function hasTable(executor: SqliteExecutor, name: string): Promise<boolean> {
	return (await executor.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)) !== undefined;
}

async function schemaVersion(executor: SqliteExecutor, t: Tables): Promise<SqliteValue | undefined> {
	const rows = await executor.all<SqliteRow & { schema_version: SqliteValue }>(`SELECT schema_version FROM ${t.meta}`);
	return rows.length === 1 ? rows[0]!.schema_version : undefined;
}

/** One journal file an export reads, inside one read transaction, so every run it holds is read as of one moment. */
interface ExportSource {
	readonly path: string;
	readonly shardId?: number;
	readonly database: SqliteDatabase;
	readonly runs: readonly JournalRunTableRow[];
	readonly runIds: ReadonlySet<string>;
}

/** A journal file an export could not read, and whether that is because it holds only the format before 0.9.38. */
interface UnreadableSource {
	readonly path: string;
	readonly reason: string;
	readonly oldFormat: boolean;
}

/** Opens a journal file for an export and begins its read transaction; the reason when it cannot. */
async function openExportSource(
	path: string,
	t: Tables,
	shardId: number | undefined,
): Promise<ExportSource | UnreadableSource> {
	if (!existsSync(path)) return { path, reason: "the journal file no longer exists", oldFormat: false };
	let database: SqliteDatabase;
	try {
		database = await openNodeSqliteDatabase(path, { readOnly: true });
	} catch (error) {
		return { path, reason: `the journal file cannot be opened: ${(error as Error).message}`, oldFormat: false };
	}
	try {
		await database.exec("BEGIN");
		if (!(await hasTables(database, t))) {
			await database.exec("COMMIT");
			await database.close();
			return { path, reason: "it has no workflow runs in the current journal format", oldFormat: true };
		}
		const version = await schemaVersion(database, t);
		if (version !== RUN_JOURNAL_SCHEMA_VERSION) {
			await database.exec("COMMIT");
			await database.close();
			return { path, reason: `unsupported journal schema version ${String(version)}`, oldFormat: false };
		}
		const runs = await database.all<JournalRunTableRow>(`SELECT * FROM ${t.runs} ORDER BY run_id`);
		return {
			path,
			database,
			runs,
			runIds: new Set(runs.map((run) => run.run_id)),
			...(shardId === undefined ? {} : { shardId }),
		};
	} catch (error) {
		await database.close().catch(() => undefined);
		return { path, reason: `the journal file cannot be read: ${(error as Error).message}`, oldFormat: false };
	}
}

async function closeExportSource(source: ExportSource): Promise<void> {
	await source.database.exec("COMMIT").catch(() => undefined);
	await source.database.close();
}

/**
 * Adopts the default journal of Atomic before the journal store, as opening the store does, so its runs are exported
 * and compared like every other run; whether the store has a catalog.
 */
async function adoptLegacyJournal(directory: string): Promise<boolean> {
	if (existsSync(legacyDefaultJournalPath(directory))) {
		const catalog = await JournalCatalog.open(directory);
		await withCleanup(
			async () => {
				await discoverLegacyJournal(catalog, legacyDefaultJournalPath(directory));
			},
			() => catalog.close(),
		);
	}
	return existsSync(join(directory, JOURNAL_CATALOG_FILE));
}

/** What the catalog of a journal store says at one moment: its shards, and its runs with the shard each is on. */
interface CatalogView {
	readonly shards: readonly JournalShardRecord[];
	readonly runs: readonly JournalCatalogRun[];
	readonly owners: ReadonlyMap<string, number>;
}

async function readCatalog(directory: string): Promise<CatalogView> {
	const catalog = await JournalCatalog.open(directory);
	return withCleanup(
		async () => {
			const shards = await catalog.shards();
			const runs = await catalog.runs();
			return { shards, runs, owners: new Map(runs.map((run) => [run.runId, run.shard])) };
		},
		() => catalog.close(),
	);
}

function newestFirst(left: JournalRunTableRow, right: JournalRunTableRow): number {
	const created = Number(right.created_at) - Number(left.created_at);
	if (created !== 0) return created;
	return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
}

/** The journal files of a store an export reads, by shard, kept open in their read transactions until it finishes. */
class ExportSources {
	readonly opened = new Map<number, ExportSource>();
	readonly unreadable = new Map<number, UnreadableSource>();

	private readonly t: Tables;

	constructor(t: Tables) {
		this.t = t;
	}

	/** Opens every shard of `view` not opened yet, and opens `fresh` again with a new snapshot. */
	async open(view: CatalogView, fresh: ReadonlySet<number> = new Set()): Promise<void> {
		for (const shard of view.shards) {
			const current = this.opened.get(shard.id);
			if (current !== undefined && !fresh.has(shard.id)) continue;
			if (current === undefined && this.unreadable.has(shard.id) && !fresh.has(shard.id)) continue;
			if (current !== undefined) {
				this.opened.delete(shard.id);
				await closeExportSource(current);
			}
			this.unreadable.delete(shard.id);
			const source = await openExportSource(shard.path, this.t, shard.id);
			if ("database" in source) this.opened.set(shard.id, source);
			else this.unreadable.set(shard.id, source);
		}
	}

	/** The catalogued runs of `view` that the snapshot of the shard the catalog names for them does not hold. */
	missing(view: CatalogView): JournalCatalogRun[] {
		return view.runs.filter((run) => {
			const source = this.opened.get(run.shard);
			return run.status !== undefined && source !== undefined && !source.runIds.has(run.runId);
		});
	}

	close(): Promise<void> {
		return closeEach([...this.opened.values()].map((source) => ({ close: () => closeExportSource(source) })));
	}
}

/**
 * Reads a journal store's catalog and opens its shards, then reads the catalog again for every run the shard it named
 * did not hold: a consolidation may have moved the run between the two reads, into an existing shard or one it
 * created. The shard the run moved to is read again, and so on until the placements agree or the attempts run out.
 */
async function settleExportSources(directory: string, sources: ExportSources): Promise<CatalogView> {
	let view = await readCatalog(directory);
	await sources.open(view);
	for (let attempt = 1; attempt < WORKFLOW_RUN_EXPORT_PLACEMENT_ATTEMPTS; attempt++) {
		const missing = sources.missing(view);
		if (missing.length === 0) return view;
		const next = await readCatalog(directory);
		const moved = new Set<number>();
		for (const run of missing) {
			const now = next.owners.get(run.runId);
			if (now !== undefined && now !== run.shard) moved.add(now);
		}
		const added = next.shards.some((shard) => !sources.opened.has(shard.id) && !sources.unreadable.has(shard.id));
		view = next;
		if (moved.size === 0 && !added) return view;
		await sources.open(view, moved);
	}
	return view;
}

/** Why a catalogued run that its shard's snapshot does not hold, or whose shard could not be read, is not exported. */
async function missingRunReason(
	run: JournalCatalogRun,
	view: CatalogView,
	sources: ExportSources,
): Promise<{ path: string; runId: string; reason: string }> {
	const unreadable = sources.unreadable.get(run.shard);
	if (unreadable !== undefined)
		return {
			path: unreadable.path,
			runId: run.runId,
			reason: unreadable.oldFormat ? OLD_FORMAT_REASON : `its journal file cannot be read: ${unreadable.reason}`,
		};
	const source = sources.opened.get(run.shard);
	if (source === undefined) {
		const path = view.shards.find((shard) => shard.id === run.shard)?.path ?? `shard ${run.shard}`;
		return { path, runId: run.runId, reason: `the catalog names shard ${run.shard} for it, which it does not list` };
	}
	if (
		(await hasTable(source.database, LEGACY_RUNS_TABLE)) &&
		(await source.database.get(`SELECT 1 AS found FROM ${LEGACY_RUNS_TABLE} WHERE run_id = ?`, run.runId))
	)
		return { path: source.path, runId: run.runId, reason: OLD_FORMAT_REASON };
	return {
		path: source.path,
		runId: run.runId,
		reason:
			"the journal file the catalog names for it does not hold it; it was moved or deleted while the export ran, so export again",
	};
}

/**
 * Exports runs of a local workflow journal to `<directory>/<runId>.jsonl`, one file per run. Each journal file is read
 * in one read transaction, and each export file is written whole or not at all. The same journal state gives the same
 * bytes, and a file that already holds them is not rewritten. A run the store's catalog lists is taken only from the
 * shard the catalog names for it, read again when a consolidation moved it while the export ran; one that cannot be
 * exported is reported with the reason.
 */
export async function exportWorkflowRuns(
	storage: WorkflowRunTransferStorage,
	directory: string,
	options: WorkflowRunExportOptions = {},
): Promise<WorkflowRunExportReport> {
	const t = runJournalTables(storage.kind === "sqlite" ? storage.prefix : undefined);
	const skipped: { path: string; runId?: string; reason: string }[] = [];
	const sources = new ExportSources(t);
	let single: ExportSource | undefined;
	return withCleanup(
		async () => {
			const listed = new Map<string, { readonly source: ExportSource; readonly run: JournalRunTableRow }>();
			const unexported = new Map<string, { path: string; runId: string; reason: string }>();
			if (storage.kind === "sqlite") {
				if (existsSync(storage.path)) {
					const opened = await openExportSource(storage.path, t, undefined);
					if ("database" in opened) single = opened;
					else skipped.push({ path: opened.path, reason: opened.reason });
				}
				for (const run of single?.runs ?? []) listed.set(run.run_id, { source: single!, run });
			} else if (await adoptLegacyJournal(storage.directory)) {
				const view = await settleExportSources(storage.directory, sources);
				const catalogued = new Set<number>(view.runs.map((run) => run.shard));
				for (const [id, unreadable] of sources.unreadable)
					if (!catalogued.has(id)) skipped.push({ path: unreadable.path, reason: unreadable.reason });
				for (const run of view.runs) {
					const source = sources.opened.get(run.shard);
					const row = source?.runs.find((candidate) => candidate.run_id === run.runId);
					if (source !== undefined && row !== undefined) listed.set(run.runId, { source, run: row });
					else if (run.status !== undefined) unexported.set(run.runId, await missingRunReason(run, view, sources));
				}
				// A run no catalog entry names yet (another process wrote it to a shard) is taken from the first shard
				// holding it. A catalogued run is never taken from another shard, which may hold an older copy an
				// interrupted consolidation left behind.
				for (const source of sources.opened.values())
					for (const run of source.runs)
						if (!view.owners.has(run.run_id) && !listed.has(run.run_id)) listed.set(run.run_id, { source, run });
			}
			let selected = [...listed.values()];
			if (options.runs !== undefined) {
				for (const runId of options.runs) {
					if (listed.has(runId)) continue;
					const reason = unexported.get(runId);
					throw new StorageTransferError({
						path: reason?.path ?? storageLocation(storage),
						id: runId,
						reason:
							reason === undefined
								? `run ${runId} is not in this workflow journal`
								: `run ${runId} cannot be exported: ${reason.reason}`,
					});
				}
				selected = [...new Set(options.runs)].map((runId) => listed.get(runId)!);
			} else skipped.push(...unexported.values());
			if (options.unfinished) selected = selected.filter(({ run }) => !isFinishedJournalStatus(run.status));
			selected.sort((left, right) => newestFirst(left.run, right.run));
			if (options.limit !== undefined) selected = selected.slice(0, options.limit);
			await mkdir(directory, { recursive: true });
			const written: string[] = [];
			const unchanged: string[] = [];
			for (const { source, run } of selected) {
				const events = await source.database.all<JournalEventTableRow>(
					`SELECT * FROM ${t.events} WHERE run_id = ? ORDER BY seq`,
					run.run_id,
				);
				const outcome = await writeLinesAtomically(
					transferFile(directory, run.run_id),
					exportLines(run, events, source.path),
				);
				(outcome === "written" ? written : unchanged).push(run.run_id);
			}
			return { written, unchanged, skipped };
		},
		async () => {
			await sources.close();
			if (single !== undefined) await closeExportSource(single);
		},
	);
}

/** A run read from an export file and checked: everything an import writes for it. */
export interface ParsedWorkflowRun {
	readonly file: string;
	readonly header: WorkflowRunExportHeader;
	readonly events: readonly WorkflowRunExportEvent[];
}

function isObject(value: WorkflowRunExportValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidText(value: string): string | undefined {
	if (value.includes("\u0000")) return "contains a NUL character";
	if (/\p{Surrogate}/u.test(value)) return "is not well-formed Unicode";
	return undefined;
}

function counter(value: WorkflowRunExportValue | undefined, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Checks that a line has exactly `fields`; the reason when it does not. */
function fieldsReason(line: JsonObject, fields: readonly string[]): string | undefined {
	for (const field of fields) if (!(field in line)) return `has no "${field}" field`;
	for (const field of Object.keys(line)) if (!fields.includes(field)) return `has an unexpected "${field}" field`;
	return undefined;
}

/** Checks one export file, throwing a `StorageTransferError` that names the file and line. */
function parseExportFile({ file, lines }: TransferFileLines): ParsedWorkflowRun {
	const fail = (line: number | undefined, reason: string, runId?: string): never => {
		throw new StorageTransferError({ path: file, ...(line === undefined ? {} : { line }), id: runId, reason });
	};
	if (lines.length === 0) return fail(1, "is empty; expected a workflow run header");
	const parse = (index: number): JsonObject => {
		const line = lines[index]!.text;
		if (line.trim() === "") return fail(index + 1, "is empty");
		let value: WorkflowRunExportValue;
		try {
			value = JSON.parse(line) as WorkflowRunExportValue;
		} catch (error) {
			return fail(index + 1, `is not valid JSON (${(error as Error).message})`);
		}
		if (!isObject(value)) return fail(index + 1, "is not a JSON object");
		if (typeof value.type !== "string") return fail(index + 1, 'has no string "type"');
		return value;
	};
	const first = parse(0);
	if (first.type !== WORKFLOW_RUN_EXPORT_TYPE)
		fail(1, `is not an Atomic workflow run export: its type is "${first.type}", not "${WORKFLOW_RUN_EXPORT_TYPE}"`);
	if (first.version !== WORKFLOW_RUN_EXPORT_VERSION)
		fail(
			1,
			`has unsupported export version ${JSON.stringify(first.version ?? null)}; this Atomic reads version ${WORKFLOW_RUN_EXPORT_VERSION}`,
		);
	const headerFields = fieldsReason(first, HEADER_FIELDS);
	if (headerFields !== undefined) fail(1, headerFields);
	for (const field of ["runId", "name", "cwd", "status"] as const) {
		const value = first[field];
		if (typeof value !== "string") fail(1, `has a "${field}" that is not a string`);
		const reason = invalidText(value as string);
		if (reason !== undefined) fail(1, `has a "${field}" that ${reason}`);
	}
	const runId = first.runId as string;
	if (runId === "") fail(1, 'has an empty "runId"');
	if (!counter(first.createdAt, Number.MIN_SAFE_INTEGER)) fail(1, 'has a "createdAt" that is not an integer', runId);
	if (!counter(first.events, 0)) fail(1, 'has an "events" count that is not a non-negative integer', runId);
	if (!isObject(first.header)) fail(1, 'has a "header" that is not an object', runId);
	if ((first.header as JsonObject).runId !== runId)
		fail(1, `has a "header" whose runId is not the run's ID ${runId}`, runId);
	const events: WorkflowRunExportEvent[] = [];
	const keys = new Map<string, number>();
	for (let index = 1; index < lines.length; index++) {
		const line = index + 1;
		const event = parse(index);
		const reason = fieldsReason(event, EVENT_FIELDS);
		if (reason !== undefined) fail(line, reason, runId);
		if (!EVENT_TYPES.has(event.type as string)) fail(line, `has unknown event type "${event.type}"`, runId);
		if (event.seq !== index) fail(line, `has seq ${JSON.stringify(event.seq)}; expected ${index}`, runId);
		if (!counter(event.epoch, 0)) fail(line, 'has an "epoch" that is not a non-negative integer', runId);
		if (!counter(event.at, Number.MIN_SAFE_INTEGER)) fail(line, 'has an "at" that is not an integer', runId);
		const key = event.key;
		if (key !== null) {
			if (typeof key !== "string") fail(line, 'has a "key" that is neither a string nor null', runId);
			const keyReason = invalidText(key as string);
			if (keyReason !== undefined) fail(line, `has a "key" that ${keyReason}`, runId);
			const earlier = keys.get(key as string);
			if (earlier !== undefined) fail(line, `repeats the key of line ${earlier}`, runId);
			keys.set(key as string, line);
		}
		if (event.type === RUN_EVENT_TYPES.statusChanged) {
			const status = isObject(event.payload) ? event.payload.status : undefined;
			if (typeof status !== "string")
				fail(line, 'is a StatusChanged event whose payload has no string "status"', runId);
			const statusReason = invalidText(status as string);
			if (statusReason !== undefined) fail(line, `has a status that ${statusReason}`, runId);
		}
		events.push({
			type: event.type as string,
			seq: event.seq as number,
			epoch: event.epoch as number,
			key: key as string | null,
			at: event.at as number,
			payload: event.payload!,
		});
	}
	if (lines.length - 1 !== first.events)
		fail(1, `says the run has ${first.events} events, but the file has ${lines.length - 1} event lines`, runId);
	const header: WorkflowRunExportHeader = {
		type: WORKFLOW_RUN_EXPORT_TYPE,
		version: WORKFLOW_RUN_EXPORT_VERSION,
		runId,
		name: first.name as string,
		cwd: first.cwd as string,
		createdAt: first.createdAt as number,
		status: first.status as string,
		events: first.events as number,
		header: first.header as JsonObject,
	};
	return { file, header, events };
}

/**
 * Reads and checks every `*.jsonl` export file in `directory`; nothing is written. A directory that does not exist
 * holds no runs. Throws `StorageTransferError` with the file and line for the first file that is not a valid export.
 */
export async function readWorkflowRunExports(directory: string): Promise<ParsedWorkflowRun[]> {
	const parsed: ParsedWorkflowRun[] = [];
	const files = new Map<string, string>();
	for (const lines of await readTransferDirectory(directory)) {
		const run = parseExportFile(lines);
		const earlier = files.get(run.header.runId);
		if (earlier !== undefined)
			throw new StorageTransferError({
				path: run.file,
				line: 1,
				id: run.header.runId,
				reason: `run ${run.header.runId} is also in ${earlier}; keep one file per run`,
			});
		files.set(run.header.runId, run.file);
		parsed.push(run);
	}
	return parsed;
}

/** The fields import checks against a stored run: everything but string content, which a tool may redact. */
function sameEntry(stored: JournalEventTableRow, exported: WorkflowRunExportEvent): boolean {
	return (
		Number(stored.seq) === exported.seq &&
		Number(stored.epoch) === exported.epoch &&
		stored.key === exported.key &&
		stored.type === exported.type &&
		Number(stored.at) === exported.at
	);
}

interface StoredRun {
	readonly run: JournalRunTableRow;
	readonly events: readonly JournalEventTableRow[];
	readonly lease?: JournalLeaseTableRow & { readonly age_ms: number };
}

async function readStoredRun(executor: SqliteExecutor, t: Tables, runId: string): Promise<StoredRun | undefined> {
	if (!(await hasTables(executor, t))) return undefined;
	const run = await executor.get<JournalRunTableRow>(`SELECT * FROM ${t.runs} WHERE run_id = ?`, runId);
	if (run === undefined) return undefined;
	const events = await executor.all<JournalEventTableRow>(
		`SELECT * FROM ${t.events} WHERE run_id = ? ORDER BY seq`,
		runId,
	);
	const lease = (await hasTable(executor, t.leases))
		? await executor.get<JournalLeaseTableRow & { age_ms: number }>(
				`SELECT *, MAX(0, ${STORE_NOW} - renewed_at) AS age_ms FROM ${t.leases} WHERE run_id = ?`,
				runId,
			)
		: undefined;
	return { run, events, ...(lease === undefined ? {} : { lease }) };
}

/**
 * What of a stored run an import depends on: its status, how many events it has and the last of them, and its lease.
 * A run whose fingerprint differs from the one the import checked was changed by another process in between.
 */
function fingerprint(stored: StoredRun | undefined): string {
	if (stored === undefined) return "absent";
	const last = stored.events.at(-1);
	const lease = stored.lease;
	return JSON.stringify([
		stored.run.status,
		Number(stored.run.created_at),
		stored.events.length,
		last === undefined ? null : [Number(last.seq), Number(last.epoch), last.key, last.type, Number(last.at)],
		lease === undefined ? null : [lease.holder_id, Number(lease.epoch), Number(lease.renewed_at)],
	]);
}

/** What an import does to one run. */
export type WorkflowRunImportAction = "add" | "update" | "unchanged";

/**
 * What importing `parsed` does to the run as `stored` holds it: add it, add the file's later events, or nothing when
 * the storage already holds every event of the file. A run whose history differs from the file's, or that a process
 * here may still be running, fails with the file and line.
 */
function importAction(
	parsed: ParsedWorkflowRun,
	stored: StoredRun | undefined,
	location: string,
): WorkflowRunImportAction {
	if (stored === undefined) return "add";
	const { header, events, file } = parsed;
	const fail = (line: number, reason: string): never => {
		throw new StorageTransferError({ path: file, line, id: header.runId, reason });
	};
	if (Number(stored.run.created_at) !== header.createdAt)
		fail(1, `run ${header.runId} in ${location} was created at another time; it is a different run with the same ID`);
	const shared = Math.min(stored.events.length, events.length);
	for (let index = 0; index < shared; index++)
		if (!sameEntry(stored.events[index]!, events[index]!))
			fail(
				index + 2,
				`event ${index + 1} differs from event ${index + 1} of run ${header.runId} in ${location}: the run continued differently there`,
			);
	if (events.length <= stored.events.length) return "unchanged";
	const lease = stored.lease;
	if (lease !== undefined && lease.holder_id !== null && Number(lease.age_ms) < WORKFLOW_RUN_IMPORT_LIVE_LEASE_MS)
		fail(
			1,
			`run ${header.runId} is held by ${lease.holder_id} in ${location}, which may still be running it; stop it and import again`,
		);
	return "update";
}

/**
 * Writes the part of `parsed` that `stored` lacks inside the caller's transaction: the run row when it is new, the
 * events after the stored ones, the latest status, and an unheld lease at an epoch above every epoch the run's events
 * and any earlier holder used, so no holder from another machine is imported and a stale one here is fenced.
 */
async function writeImport(
	tx: SqliteExecutor,
	t: Tables,
	parsed: ParsedWorkflowRun,
	stored: StoredRun | undefined,
): Promise<void> {
	const { header, events } = parsed;
	if (stored === undefined)
		await tx.run(
			`INSERT INTO ${t.runs}(run_id, name, cwd, created_at, status, header_json) VALUES (?, ?, ?, ?, ?, ?)`,
			header.runId,
			header.name,
			header.cwd,
			header.createdAt,
			header.status,
			JSON.stringify(header.header),
		);
	else await tx.run(`UPDATE ${t.runs} SET status = ? WHERE run_id = ?`, header.status, header.runId);
	for (const event of events.slice(stored?.events.length ?? 0))
		await tx.run(
			`INSERT INTO ${t.events}(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			header.runId,
			event.seq,
			event.epoch,
			event.key,
			event.type,
			JSON.stringify(event.payload),
			event.at,
		);
	const epoch = events.reduce((highest, event) => Math.max(highest, event.epoch), 0);
	await tx.run(
		`INSERT INTO ${t.leases}(run_id, holder_id, epoch, renewed_at) VALUES (?, NULL, ?, ${STORE_NOW})
		ON CONFLICT(run_id) DO UPDATE SET holder_id = NULL, renewed_at = excluded.renewed_at,
			epoch = MAX(excluded.epoch, ${t.leases}.epoch + (CASE WHEN ${t.leases}.holder_id IS NULL THEN 0 ELSE 1 END))`,
		header.runId,
		epoch,
	);
}

/** A journal file an import reads its runs from while it decides what to write: read-only, opened once. */
class ReadOnlyFiles {
	private readonly opened = new Map<string, Promise<SqliteDatabase>>();

	read(path: string): Promise<SqliteDatabase> {
		let database = this.opened.get(path);
		if (database === undefined) {
			database = openNodeSqliteDatabase(path, { readOnly: true });
			this.opened.set(path, database);
		}
		return database;
	}

	async close(): Promise<void> {
		const settled = await Promise.allSettled(this.opened.values());
		await closeEach(settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
	}
}

function unreadableShard(parsed: ParsedWorkflowRun, path: string, error: Error): StorageTransferError {
	return new StorageTransferError({
		path: parsed.file,
		line: 1,
		id: parsed.header.runId,
		reason: `run ${parsed.header.runId} is in the journal file ${path}, which cannot be read: ${error.message}`,
		cause: error,
	});
}

/**
 * The shard of a store holding `runId`: the one the catalog names, else any shard that holds it although the catalog
 * does not list it, as an adopted journal another process wrote to or a shard an interrupted import wrote to before
 * it recorded the run in the catalog.
 */
async function storedShard(
	catalog: JournalCatalog,
	files: ReadOnlyFiles,
	t: Tables,
	runId: string,
): Promise<{ readonly shard: JournalShardRecord; readonly catalogued: boolean } | undefined> {
	const found = await catalog.locate(runId);
	if (found !== undefined) return { shard: found.shard, catalogued: true };
	for (const shard of await catalog.shards()) {
		if (!existsSync(shard.path)) continue;
		try {
			const database = await files.read(shard.path);
			if ((await hasTables(database, t)) && (await database.get(`SELECT 1 FROM ${t.runs} WHERE run_id = ?`, runId)))
				return { shard, catalogued: false };
		} catch {}
	}
	return undefined;
}

/** One run of an import plan: what the import does to it, and the storage's copy the decision was made on. */
interface PlannedRun {
	readonly run: ParsedWorkflowRun;
	readonly action: WorkflowRunImportAction;
	readonly stored: StoredRun | undefined;
	/** The shard holding the run; for a store only. */
	readonly shard?: JournalShardRecord;
	/** Whether the store's catalog lists the run. */
	readonly catalogued: boolean;
}

/** What importing a set of export files does to a local workflow journal, decided before anything is written. */
export interface WorkflowRunImportPlan {
	readonly storage: WorkflowRunTransferStorage;
	readonly runs: readonly PlannedRun[];
}

/** The runs of a plan an import writes. */
export function pendingWorkflowRuns(plan: WorkflowRunImportPlan): string[] {
	return plan.runs.filter((run) => run.action !== "unchanged").map((run) => run.run.header.runId);
}

/**
 * Compares every run of `runs` with the storage's copy, writing nothing: a run that continued differently here, or that
 * a process here may still be running, fails with the file and line.
 */
export async function planWorkflowRunImport(
	storage: WorkflowRunTransferStorage,
	runs: readonly ParsedWorkflowRun[],
): Promise<WorkflowRunImportPlan> {
	const t = runJournalTables(storage.kind === "sqlite" ? storage.prefix : undefined);
	const location = storageLocation(storage);
	const files = new ReadOnlyFiles();
	const planned: PlannedRun[] = [];
	if (runs.length === 0) return { storage, runs: planned };
	await withCleanup(
		async () => {
			const catalogExists = storage.kind === "store" && (await adoptLegacyJournal(storage.directory));
			const catalog = catalogExists ? await JournalCatalog.open(storage.directory) : undefined;
			await withCleanup(
				async () => {
					for (const run of runs) {
						const found =
							catalog === undefined ? undefined : await storedShard(catalog, files, t, run.header.runId);
						let path = found?.shard.path;
						if (storage.kind === "sqlite") path = existsSync(storage.path) ? storage.path : undefined;
						let stored: StoredRun | undefined;
						if (path !== undefined && existsSync(path)) {
							try {
								stored = await readStoredRun(await files.read(path), t, run.header.runId);
							} catch (error) {
								throw unreadableShard(run, path, error as Error);
							}
						}
						planned.push({
							run,
							action: importAction(run, stored, path ?? location),
							stored,
							catalogued: found?.catalogued ?? false,
							...(found === undefined ? {} : { shard: found.shard }),
						});
					}
				},
				async () => catalog?.close(),
			);
		},
		() => files.close(),
	);
	return { storage, runs: planned };
}

/** The runs an import writes to one journal file, under that file's write lock. */
interface ImportGroup {
	readonly path: string;
	readonly shard?: JournalShardRecord;
	readonly runs: PlannedRun[];
	database?: SqliteDatabase;
	tx?: SqliteExecutor;
}

/**
 * Writes what `plan` decided. Every journal file the import writes to is opened and its write lock taken, in path
 * order, before anything is written, and every run is compared again under those locks: a run another process changed
 * since the plan was made (a resume took its lease, events were added, a consolidation moved it) fails the import with
 * nothing written. The locks are held until the last run is written; each file then commits. Separate journal files
 * cannot commit together, so when one fails to commit after another did, `StorageImportIncompleteError` names the runs
 * written and the runs not written, and importing again writes only the rest. A store's catalog records added runs
 * after their files commit; a run an interrupted import wrote before recording it is found and recorded by the next.
 */
export async function applyWorkflowRunImport(plan: WorkflowRunImportPlan): Promise<WorkflowRunImportReport> {
	const { storage } = plan;
	const prefix = storage.kind === "sqlite" ? storage.prefix : undefined;
	const t = runJournalTables(prefix);
	const report = { added: [] as string[], updated: [] as string[], unchanged: [] as string[] };
	const pending = plan.runs.filter((run) => {
		if (run.action === "unchanged") report.unchanged.push(run.run.header.runId);
		return run.action !== "unchanged";
	});
	const uncatalogued = plan.runs.filter((run) => run.action === "unchanged" && !run.catalogued && run.shard);
	if (pending.length === 0 && uncatalogued.length === 0) return report;
	const catalog = storage.kind === "store" ? await JournalCatalog.open(storage.directory) : undefined;
	const groups = new Map<string, ImportGroup>();
	const committed: ImportGroup[] = [];
	const written = () => committed.flatMap((group) => group.runs.map((run) => run.run.header.runId));
	try {
		for (const run of pending) {
			const shard =
				catalog === undefined ? undefined : (run.shard ?? (await catalog.homeShard(run.run.header.runId)));
			const path = shard?.path ?? storageLocation(storage);
			let group = groups.get(path);
			if (group === undefined) {
				group = { path, runs: [], ...(shard === undefined ? {} : { shard }) };
				groups.set(path, group);
			}
			group.runs.push(run);
		}
		const ordered = [...groups.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
		for (const group of ordered) {
			try {
				group.database = await openNodeSqliteDatabase(group.path);
			} catch (error) {
				throw unreadableShard(group.runs[0]!.run, group.path, error as Error);
			}
		}
		const lockAll = async (index: number): Promise<void> => {
			if (index === ordered.length) {
				for (const group of ordered)
					for (const run of group.runs) {
						const now = await readStoredRun(group.tx!, t, run.run.header.runId);
						if (fingerprint(now) !== fingerprint(run.stored))
							throw new StorageTransferError({
								path: run.run.file,
								line: 1,
								id: run.run.header.runId,
								reason: `run ${run.run.header.runId} changed in ${group.path} after the import compared it (another process wrote to it, took its lease or moved it); nothing was imported, so import again`,
							});
						importAction(run.run, now, group.path);
					}
				for (const group of ordered) {
					await ensureRunJournalSchema(group.tx!, prefix);
					for (const run of group.runs) await writeImport(group.tx!, t, run.run, run.stored);
				}
				return;
			}
			const group = ordered[index]!;
			await group.database!.transaction(async (tx) => {
				group.tx = tx;
				await lockAll(index + 1);
			}, TRANSFER_TRANSACTION);
			committed.push(group);
		};
		await lockAll(0);
		if (catalog !== undefined) {
			for (const group of ordered)
				for (const run of group.runs) {
					const { runId, name, cwd, status } = run.run.header;
					if (run.catalogued) await catalog.setStatus(runId, status);
					else await catalog.index(group.shard!.id, { runId, name, cwd, status });
				}
			for (const run of uncatalogued) {
				const { runId, name, cwd, status } = run.run.header;
				await catalog.index(run.shard!.id, { runId, name, cwd, status });
			}
		}
	} catch (error) {
		const done = written();
		if (done.length === 0) throw error;
		const doneSet = new Set(done);
		throw new StorageImportIncompleteError(error as Error, {
			written: { sessions: [], workflows: done },
			notWritten: {
				sessions: [],
				workflows: pending.map((run) => run.run.header.runId).filter((runId) => !doneSet.has(runId)),
			},
		});
	} finally {
		await closeEach(
			[...groups.values()].flatMap((group) => (group.database === undefined ? [] : [group.database])),
		).catch(() => undefined);
		await catalog?.close();
	}
	for (const run of pending) (run.action === "add" ? report.added : report.updated).push(run.run.header.runId);
	return report;
}

/**
 * Imports every `<name>.jsonl` export file in `directory` into a local workflow journal: `readWorkflowRunExports`,
 * `planWorkflowRunImport` and `applyWorkflowRunImport` in turn. Every file is read and checked, and every run compared
 * with the storage's copy, before anything is written. A run the storage does not hold is added; one whose earlier
 * events it holds gets the file's later ones; one it holds every event of is left as it is, so importing again changes
 * nothing. String values inside the records are not compared, so a file whose strings a tool redacted imports as the
 * run it was exported from.
 */
export async function importWorkflowRuns(
	storage: WorkflowRunTransferStorage,
	directory: string,
): Promise<WorkflowRunImportReport> {
	return applyWorkflowRunImport(await planWorkflowRunImport(storage, await readWorkflowRunExports(directory)));
}
