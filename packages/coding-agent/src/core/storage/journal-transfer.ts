/**
 * Workflow runs as versioned JSONL files (#4716): `exportWorkflowRuns` writes each run of a local workflow journal to
 * `<dir>/<runId>.jsonl`, and `importWorkflowRuns` restores such files into one. The journal stays the working store;
 * the files are the form runs take at rest, so a host that persists only files can carry them between machines.
 *
 * Line 1 of a file is the run's header: the row of the journal's runs table. Every later line is one row of its
 * events table, in sequence order, with its payload as a JSON value instead of JSON text. Leases, local-worker pool
 * state and worktree snapshot blobs are not exported: they belong to the machine that wrote them.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeEach, withCleanup } from "./cleanup.js";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import { StorageError, type StorageFailureCause } from "./errors.js";
import {
	ensureRunJournalSchema,
	type JournalEventTableRow,
	type JournalLeaseTableRow,
	type JournalRunTableRow,
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

/** The `type` of an export file's header line. */
export const WORKFLOW_RUN_EXPORT_TYPE = "atomic.workflow-run";
/** The export format version this Atomic writes and reads. */
export const WORKFLOW_RUN_EXPORT_VERSION = 1;
/** The file name extension of an exported run; import reads every file with it and ignores the rest. */
export const WORKFLOW_RUN_EXPORT_EXTENSION = ".jsonl";
/**
 * A lease renewed this recently belongs to a process that may still be running the run on this machine, so an import
 * does not add events to that run. It matches the window in which the workflows runtime treats a running run's owner
 * as live.
 */
export const WORKFLOW_RUN_IMPORT_LIVE_LEASE_MS = 120_000;

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

export interface WorkflowRunTransferErrorInit {
	/** The file or storage location the error is about. */
	readonly path: string;
	/** The 1-based line of `path`. */
	readonly line?: number;
	readonly runId?: string;
	readonly reason: string;
	readonly cause?: StorageFailureCause;
}

/** An export or import that could not be done; an import that fails this way changed nothing. */
export class WorkflowRunTransferError extends StorageError {
	override readonly name = "WorkflowRunTransferError" as const;
	readonly path: string;
	readonly line: number | undefined;
	readonly runId: string | undefined;
	readonly reason: string;

	constructor(init: WorkflowRunTransferErrorInit) {
		super(`${init.path}${init.line === undefined ? "" : `:${init.line}`}: ${init.reason}`, { cause: init.cause });
		this.path = init.path;
		this.line = init.line;
		this.runId = init.runId;
		this.reason = init.reason;
	}
}

export function isWorkflowRunTransferError(value: unknown): value is WorkflowRunTransferError {
	if (value instanceof WorkflowRunTransferError) return true;
	return (
		typeof value === "object" && value !== null && (value as { name?: unknown }).name === "WorkflowRunTransferError"
	);
}

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
	/** Journal files that could not be read, and runs the catalog lists that no readable journal holds. */
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

type JsonObject = { readonly [key: string]: WorkflowRunExportValue };
type Tables = ReturnType<typeof runJournalTables>;

/** The file an exported run is written to in `directory`. */
export function workflowRunExportFile(directory: string, runId: string): string {
	return join(directory, `${encodeURIComponent(runId)}${WORKFLOW_RUN_EXPORT_EXTENSION}`);
}

function storageLocation(storage: WorkflowRunTransferStorage): string {
	return storage.kind === "store" ? storage.directory : storage.path;
}

function parseStored(text: string, path: string, runId: string, what: string): WorkflowRunExportValue {
	try {
		return JSON.parse(text) as WorkflowRunExportValue;
	} catch (cause) {
		throw new WorkflowRunTransferError({
			path,
			runId,
			reason: `run ${runId} has ${what} that is not valid JSON`,
			cause: cause as StorageFailureCause,
		});
	}
}

/** A run and its events as the lines of its export file, newline-terminated. */
function exportText(run: JournalRunTableRow, events: readonly JournalEventTableRow[], path: string): string {
	const header = parseStored(run.header_json, path, run.run_id, "a header");
	if (!isObject(header))
		throw new WorkflowRunTransferError({
			path,
			runId: run.run_id,
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
	return `${lines.join("\n")}\n`;
}

/**
 * Writes `content` to `file` through a temporary file in the same directory that is flushed and then renamed over it,
 * so `file` holds either its earlier content or all of `content`. A file that already holds `content` is left alone.
 */
async function writeAtomically(file: string, content: string): Promise<"written" | "unchanged"> {
	const existing = await readFile(file, "utf8").catch(() => undefined);
	if (existing === content) return "unchanged";
	const temporary = join(resolve(file, ".."), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx");
		await withCleanup(
			async () => {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			},
			() => handle.close(),
		);
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw new WorkflowRunTransferError({
			path: file,
			reason: `cannot write the export file: ${(error as Error).message}`,
			cause: error as StorageFailureCause,
		});
	}
	return "written";
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
}

/** Opens a journal file for an export and begins its read transaction; undefined, with the reason, when it cannot. */
async function openExportSource(
	path: string,
	t: Tables,
	shardId: number | undefined,
): Promise<ExportSource | { readonly path: string; readonly reason: string }> {
	if (!existsSync(path)) return { path, reason: "the journal file no longer exists" };
	let database: SqliteDatabase;
	try {
		database = await openNodeSqliteDatabase(path, { readOnly: true });
	} catch (error) {
		return { path, reason: `the journal file cannot be opened: ${(error as Error).message}` };
	}
	try {
		await database.exec("BEGIN");
		if (!(await hasTables(database, t))) {
			await database.exec("COMMIT");
			await database.close();
			return { path, reason: "it has no workflow runs in the current journal format" };
		}
		const version = await schemaVersion(database, t);
		if (version !== RUN_JOURNAL_SCHEMA_VERSION) {
			await database.exec("COMMIT");
			await database.close();
			return { path, reason: `unsupported journal schema version ${String(version)}` };
		}
		const runs = await database.all<JournalRunTableRow>(`SELECT * FROM ${t.runs} ORDER BY run_id`);
		return { path, database, runs, ...(shardId === undefined ? {} : { shardId }) };
	} catch (error) {
		await database.close().catch(() => undefined);
		return { path, reason: `the journal file cannot be read: ${(error as Error).message}` };
	}
}

function newestFirst(left: JournalRunTableRow, right: JournalRunTableRow): number {
	const created = Number(right.created_at) - Number(left.created_at);
	if (created !== 0) return created;
	return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
}

/**
 * Exports runs of a local workflow journal to `<directory>/<runId>.jsonl`, one file per run. Each journal file is read
 * in one read transaction, and each export file is written whole or not at all. The same journal state gives the same
 * bytes, and a file that already holds them is not rewritten.
 */
export async function exportWorkflowRuns(
	storage: WorkflowRunTransferStorage,
	directory: string,
	options: WorkflowRunExportOptions = {},
): Promise<WorkflowRunExportReport> {
	const t = runJournalTables(storage.kind === "sqlite" ? storage.prefix : undefined);
	const skipped: { path: string; runId?: string; reason: string }[] = [];
	const sources: ExportSource[] = [];
	let owners: ReadonlyMap<string, number> | undefined;
	let catalogued: readonly JournalCatalogRun[] = [];
	const add = (opened: Awaited<ReturnType<typeof openExportSource>>) => {
		if ("database" in opened) sources.push(opened);
		else skipped.push(opened);
	};
	return withCleanup(
		async () => {
			if (storage.kind === "sqlite") {
				if (existsSync(storage.path)) add(await openExportSource(storage.path, t, undefined));
			} else if (existsSync(join(storage.directory, JOURNAL_CATALOG_FILE))) {
				const catalog = await JournalCatalog.open(storage.directory);
				let shards: readonly JournalShardRecord[];
				await withCleanup(
					async () => {
						shards = await catalog.shards();
						catalogued = await catalog.runs();
						owners = new Map(catalogued.map((run) => [run.runId, run.shard]));
					},
					() => catalog.close(),
				);
				for (const shard of shards!) add(await openExportSource(shard.path, t, shard.id));
			}
			const listed = new Map<string, { readonly source: ExportSource; readonly run: JournalRunTableRow }>();
			for (const source of sources)
				for (const run of source.runs) {
					const owner = owners?.get(run.run_id);
					if (owner === undefined ? listed.has(run.run_id) : owner !== source.shardId) continue;
					listed.set(run.run_id, { source, run });
				}
			// A run whose journal file was read but does not hold it in the current tables is in the pre-0.9.38 format;
			// the runs of a journal file that could not be read are covered by that file's own entry, and a root that is
			// only reserved (no status yet) has nothing to export.
			if (options.runs === undefined)
				for (const entry of catalogued) {
					const source = sources.find((candidate) => candidate.shardId === entry.shard);
					if (!listed.has(entry.runId) && source !== undefined && entry.status !== undefined)
						skipped.push({
							path: source.path,
							runId: entry.runId,
							reason: "it is in the journal format of Atomic before 0.9.38; resume it once to convert it",
						});
				}
			let selected = [...listed.values()];
			if (options.runs !== undefined) {
				const missing = options.runs.find((runId) => !listed.has(runId));
				if (missing !== undefined)
					throw new WorkflowRunTransferError({
						path: storageLocation(storage),
						runId: missing,
						reason: `run ${missing} is not in this workflow journal`,
					});
				selected = [...new Set(options.runs)].map((runId) => listed.get(runId)!);
			}
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
				const file = workflowRunExportFile(directory, run.run_id);
				const outcome = await writeAtomically(file, exportText(run, events, source.path));
				(outcome === "written" ? written : unchanged).push(run.run_id);
			}
			return { written, unchanged, skipped };
		},
		async () => {
			await Promise.allSettled(sources.map((source) => source.database.exec("COMMIT")));
			await closeEach(sources.map((source) => source.database));
		},
	);
}

/** A run read from an export file and checked: everything an import writes for it. */
interface ParsedRun {
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

/** Reads and checks one export file, throwing a `WorkflowRunTransferError` that names the file and line. */
function parseExportFile(file: string, bytes: Buffer): ParsedRun {
	const fail = (line: number | undefined, reason: string, runId?: string): never => {
		throw new WorkflowRunTransferError({ path: file, ...(line === undefined ? {} : { line }), runId, reason });
	};
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return fail(undefined, "is not valid UTF-8 text");
	}
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return fail(1, "is empty; expected a workflow run header");
	const parse = (index: number): JsonObject => {
		const line = lines[index]!;
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
	const leases = await executor.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t.leases);
	const lease =
		leases === undefined
			? undefined
			: await executor.get<JournalLeaseTableRow & { age_ms: number }>(
					`SELECT *, MAX(0, ${STORE_NOW} - renewed_at) AS age_ms FROM ${t.leases} WHERE run_id = ?`,
					runId,
				);
	return { run, events, ...(lease === undefined ? {} : { lease }) };
}

type ImportAction = "add" | "update" | "unchanged";

/**
 * What importing `parsed` does to the run as `stored` holds it: add it, add the file's later events, or nothing when
 * the storage already holds every event of the file. A run whose history differs from the file's, or that a process
 * here may still be running, fails with the file and line.
 */
function importAction(parsed: ParsedRun, stored: StoredRun | undefined, location: string): ImportAction {
	if (stored === undefined) return "add";
	const { header, events, file } = parsed;
	const fail = (line: number, reason: string): never => {
		throw new WorkflowRunTransferError({ path: file, line, runId: header.runId, reason });
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
async function applyImport(tx: SqliteExecutor, t: Tables, parsed: ParsedRun, location: string): Promise<ImportAction> {
	const { header, events } = parsed;
	const action = importAction(parsed, await readStoredRun(tx, t, header.runId), location);
	if (action === "unchanged") return action;
	if (action === "add")
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
	const stored =
		action === "add"
			? 0
			: Number(
					(await tx.get<SqliteRow & { seq: number }>(
						`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${t.events} WHERE run_id = ?`,
						header.runId,
					))!.seq,
				);
	for (const event of events.slice(stored))
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
	return action;
}

/** Reads and checks every export file in `directory`; nothing is written. */
async function readExportDirectory(directory: string): Promise<ParsedRun[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		throw new WorkflowRunTransferError({
			path: directory,
			reason: `cannot read the directory: ${(error as Error).message}`,
			cause: error as StorageFailureCause,
		});
	}
	const parsed: ParsedRun[] = [];
	const files = new Map<string, string>();
	for (const name of names.filter((entry) => entry.endsWith(WORKFLOW_RUN_EXPORT_EXTENSION)).sort()) {
		const file = join(directory, name);
		let bytes: Buffer;
		try {
			bytes = await readFile(file);
		} catch (error) {
			throw new WorkflowRunTransferError({
				path: file,
				reason: `cannot read the file: ${(error as Error).message}`,
				cause: error as StorageFailureCause,
			});
		}
		const run = parseExportFile(file, bytes);
		const earlier = files.get(run.header.runId);
		if (earlier !== undefined)
			throw new WorkflowRunTransferError({
				path: file,
				line: 1,
				runId: run.header.runId,
				reason: `run ${run.header.runId} is also in ${earlier}; keep one file per run`,
			});
		files.set(run.header.runId, file);
		parsed.push(run);
	}
	return parsed;
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

function unreadableShard(parsed: ParsedRun, path: string, error: Error): WorkflowRunTransferError {
	return new WorkflowRunTransferError({
		path: parsed.file,
		line: 1,
		runId: parsed.header.runId,
		reason: `run ${parsed.header.runId} is in the journal file ${path}, which cannot be read: ${error.message}`,
		cause: error,
	});
}

/** The journal file of a store holding `runId`: the one the catalog names, else an adopted journal that holds it. */
async function storedShard(
	catalog: JournalCatalog,
	files: ReadOnlyFiles,
	t: Tables,
	runId: string,
): Promise<JournalShardRecord | undefined> {
	const found = await catalog.locate(runId);
	if (found !== undefined) return found.shard;
	for (const shard of await catalog.shards()) {
		if (shard.kind !== "adopted" || !existsSync(shard.path)) continue;
		try {
			const database = await files.read(shard.path);
			if ((await hasTables(database, t)) && (await database.get(`SELECT 1 FROM ${t.runs} WHERE run_id = ?`, runId)))
				return shard;
		} catch {}
	}
	return undefined;
}

/**
 * Imports every `<name>.jsonl` export file in `directory` into a local workflow journal. Every file is read and checked,
 * and every run compared with the storage's copy, before anything is written: a malformed file, an unsupported version,
 * a run that continued differently here, or a run a process here may still be running fails the import with the file
 * and line, and nothing changes. A run the storage does not hold is added; one whose earlier events it holds gets the
 * file's later ones; one it holds every event of is left as it is, so importing again changes nothing. String values
 * inside the records are not compared, so a file whose strings a tool redacted imports as the run it was exported from.
 */
export async function importWorkflowRuns(
	storage: WorkflowRunTransferStorage,
	directory: string,
): Promise<WorkflowRunImportReport> {
	const runs = await readExportDirectory(directory);
	const t = runJournalTables(storage.kind === "sqlite" ? storage.prefix : undefined);
	const location = storageLocation(storage);
	const files = new ReadOnlyFiles();
	const actions: { readonly run: ParsedRun; readonly action: ImportAction; readonly shard?: JournalShardRecord }[] =
		[];
	await withCleanup(
		async () => {
			const catalogExists = storage.kind === "store" && existsSync(join(storage.directory, JOURNAL_CATALOG_FILE));
			const catalog = catalogExists ? await JournalCatalog.open(storage.directory) : undefined;
			await withCleanup(
				async () => {
					for (const run of runs) {
						const shard =
							catalog === undefined ? undefined : await storedShard(catalog, files, t, run.header.runId);
						let path = shard?.path;
						if (storage.kind === "sqlite") path = existsSync(storage.path) ? storage.path : undefined;
						let stored: StoredRun | undefined;
						if (path !== undefined) {
							try {
								stored = await readStoredRun(await files.read(path), t, run.header.runId);
							} catch (error) {
								throw unreadableShard(run, path, error as Error);
							}
						}
						actions.push({
							run,
							action: importAction(run, stored, path ?? location),
							...(shard === undefined ? {} : { shard }),
						});
					}
				},
				async () => catalog?.close(),
			);
		},
		() => files.close(),
	);
	const report = { added: [] as string[], updated: [] as string[], unchanged: [] as string[] };
	const record = (runId: string, action: ImportAction) =>
		(action === "add" ? report.added : action === "update" ? report.updated : report.unchanged).push(runId);
	const pending = actions.filter(({ action, run }) => {
		if (action === "unchanged") record(run.header.runId, action);
		return action !== "unchanged";
	});
	if (pending.length === 0) return report;
	if (storage.kind === "sqlite") {
		const database = await openNodeSqliteDatabase(storage.path);
		await withCleanup(
			async () => {
				for (const { run } of pending)
					record(
						run.header.runId,
						await database.transaction(async (tx) => {
							await ensureRunJournalSchema(tx, storage.prefix);
							return applyImport(tx, t, run, location);
						}, TRANSFER_TRANSACTION),
					);
			},
			() => database.close(),
		);
		return report;
	}
	const catalog = await JournalCatalog.open(storage.directory);
	const shards = new Map<string, SqliteDatabase>();
	await withCleanup(
		async () => {
			for (const { run, shard: stored } of pending) {
				const { runId, name, cwd, status } = run.header;
				// A new run goes to the shard its ID hashes to, as a consolidated run does: it writes nothing until it is
				// resumed, so it never makes a shard busy for new roots.
				const shard = await catalog.shard(
					await catalog.index((stored ?? (await catalog.homeShard(runId))).id, { runId, name, cwd, status }),
				);
				if (shard === undefined)
					throw new WorkflowRunTransferError({
						path: run.file,
						line: 1,
						runId,
						reason: `cannot place run ${runId} in ${location}`,
					});
				let database = shards.get(shard.path);
				if (database === undefined) {
					try {
						database = await openNodeSqliteDatabase(shard.path);
					} catch (error) {
						throw unreadableShard(run, shard.path, error as Error);
					}
					shards.set(shard.path, database);
				}
				const action = await database.transaction(async (tx) => {
					await ensureRunJournalSchema(tx);
					return applyImport(tx, t, run, shard.path);
				}, TRANSFER_TRANSACTION);
				if (action !== "unchanged") await catalog.setStatus(runId, status);
				record(runId, action);
			}
		},
		async () => {
			await closeEach(shards.values());
			await catalog.close();
		},
	);
	return report;
}
