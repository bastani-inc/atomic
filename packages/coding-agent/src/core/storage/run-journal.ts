import type { SnapshotBlobStore } from "../worktree-snapshot/types.ts";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue, StorageDescriptor } from "./database.js";
import type { StorageDialect } from "./dialect.js";
import { StorageError, StoragePayloadTooLargeError } from "./errors.js";

function catalogTurn(): Promise<void> {
	return new Promise((resolve) =>
		typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0),
	);
}

export function responseRefused(error: unknown): boolean {
	return error instanceof StoragePayloadTooLargeError && error.kind === "response";
}

/** A refusal can close the server's transaction. Never reuse its rows, cursor or connection transaction. */
export async function retryCatalogRead<T>(
	db: SqliteDatabase,
	ordinary: () => Promise<T>,
	paged: (tx: SqliteExecutor, limit: number) => Promise<T>,
	pageRows = 256,
	check?: () => void,
): Promise<T> {
	try {
		return await ordinary();
	} catch (error) {
		if (!responseRefused(error)) throw error;
	}
	for (let limit = pageRows; ; limit = Math.max(1, Math.floor(limit / 2))) {
		await catalogTurn();
		check?.();
		try {
			return await db.transaction((tx) => paged(tx, limit), { readOnly: true, retryTransientFailures: true });
		} catch (error) {
			if (!responseRefused(error) || limit === 1) throw error;
		}
	}
}

/** Collect pages in the fallback transaction. A short page is the last; a full page advances strictly past its last key. */
export async function readCatalogPages<Row extends SqliteRow>(
	tx: SqliteExecutor,
	sql: string,
	params: readonly SqliteValue[],
	key: string,
	limit: number,
	check?: () => void,
): Promise<Row[]> {
	const rows: Row[] = [];
	for (let after: SqliteValue | undefined; ; ) {
		check?.();
		const page = await tx.all<Row>(
			`SELECT * FROM (${sql}) AS catalog ${after === undefined ? "" : `WHERE ${key} > ?`} ORDER BY ${key} LIMIT ?`,
			...params,
			...(after === undefined ? [] : [after]),
			limit,
		);
		check?.();
		for (const row of page) rows.push(row);
		if (page.length < limit) return rows;
		after = page.at(-1)![key];
		await catalogTurn();
	}
}

/**
 * The schema version of a SQL run journal's `meta` table that this Atomic reads and writes. Version 2 stores a large
 * event payload in chunks behind a stub (#4965), which a build that knows only version 1 would read as the payload, so
 * opening a journal upgrades it to 2 and older builds refuse it with `StorageSchemaVersionError`. The same version
 * covers worktree snapshot blobs stored in chunks (#4954, #5065), which the journal's snapshots reference.
 */
export const RUN_JOURNAL_SCHEMA_VERSION = 2;
/** The run journal schema builds before chunked event payloads wrote; this build upgrades it when it opens it. */
export const RUN_JOURNAL_SCHEMA_VERSION_UNCHUNKED = 1;

export const RUN_EVENT_TYPES = {
	runStarted: "RunStarted",
	runFinished: "RunFinished",
	statusChanged: "StatusChanged",
	checkpointRecorded: "CheckpointRecorded",
	promptAsked: "PromptAsked",
	promptReleased: "PromptReleased",
	controlRequested: "ControlRequested",
	messageQueued: "MessageQueued",
	messageDelivered: "MessageDelivered",
	messageSettled: "MessageSettled",
	timerScheduled: "TimerScheduled",
	summaryRecorded: "SummaryRecorded",
} as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

export type JournalSerializableValue =
	| string
	| number
	| boolean
	| null
	| readonly JournalSerializableValue[]
	| { readonly [key: string]: JournalSerializableValue | undefined };

export interface RunHeader {
	readonly runId: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly status: string;
	readonly inputs?: JournalSerializableValue;
	readonly storage?: StorageDescriptor;
}
export type RunSummary = RunHeader;

type EventOf<Type extends string, Payload = JournalSerializableValue> = {
	readonly type: Type;
	readonly payload: Payload;
};
export type RunEvent =
	| EventOf<"RunStarted" | "RunFinished">
	| EventOf<"StatusChanged", { readonly status: string; readonly [key: string]: JournalSerializableValue }>
	| EventOf<
			"CheckpointRecorded",
			{
				readonly kind: "tool" | "ui" | "stage" | "task" | "boundary";
				readonly [key: string]: JournalSerializableValue;
			}
	  >
	| EventOf<
			| "PromptAsked"
			| "PromptReleased"
			| "ControlRequested"
			| "MessageQueued"
			| "MessageDelivered"
			| "MessageSettled"
			| "TimerScheduled"
			| "SummaryRecorded"
	  >;
export interface Lease {
	readonly runId: string;
	readonly holderId: string;
	readonly epoch: number;
}
export type LeaseState = Lease & { readonly renewedAt: number; readonly ageMs: number };
export type LeaseOutcome =
	| { readonly status: "acquired"; readonly lease: Lease }
	| { readonly status: "held"; readonly holderId: string | null; readonly epoch: number };
export interface JournalEntry {
	readonly runId: string;
	readonly seq: number;
	readonly epoch: number;
	readonly key?: string;
	readonly event: RunEvent;
	readonly at: number;
}
export type AppendOutcome = { readonly status: "appended" | "exists"; readonly entry: JournalEntry };
/** A run's latest event. A run whose history was deleted and recorded again ends with a different event. */
export interface RunVersion {
	readonly seq: number;
	readonly at: number;
}
/**
 * A run's latest snapshot event (one carrying the run's handle) and the checkpoints recorded after it: enough to
 * list the run in a catalog without reading its history.
 */
export interface RunSnapshotTail {
	/** The run's latest event of any type. */
	readonly version: RunVersion;
	readonly snapshot: JournalEntry;
	readonly laterCheckpoints: number;
	/** `completedAt` of the last of `laterCheckpoints`. */
	readonly lastCheckpointAt?: number;
}
/** One append of a batch. `context` runs a function in the async context the append was issued from. */
export interface RunJournalBatchAppend {
	readonly event: RunEvent;
	readonly key?: string;
	readonly context: <R>(action: () => R) => R;
}
/** One event of a run created with `createRunWithEvents`; `key` is the event's idempotency key, as with `append`. */
export interface RunJournalSeedEvent {
	readonly event: RunEvent;
	readonly key?: string;
}
export interface RunJournal {
	createRun(header: RunHeader): Promise<"created" | "exists">;
	getRun(runId: string): Promise<RunSummary | undefined>;
	/** Lists in run-id order; SQL journals check cancellation between size-bounded pages. */
	listRuns(filter?: { cwd?: string }, options?: { signal?: AbortSignal }): Promise<readonly RunSummary[]>;
	acquire(runId: string, holderId: string): Promise<LeaseOutcome>;
	takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome>;
	takeoverExpired(runId: string, holderId: string, staleAfterMs: number): Promise<LeaseOutcome>;
	leaseState(runId: string): Promise<LeaseState | undefined>;
	renew(lease: Lease): Promise<void>;
	release(lease: Lease): Promise<void>;
	append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome>;
	read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry>;
	readKey(runId: string, key: string): Promise<JournalEntry | undefined>;
	deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void>;
	deleteRun(runId: string): Promise<void>;
	close(): Promise<void>;
	/**
	 * Optional change tracking, used only when `changeToken`, `runVersions` and `snapshotTail` are all present. The
	 * token moves whenever any connection, in this process or another, commits a change to the journal's store. It is
	 * undefined when the journal cannot tell that nothing changed, and every run's version is then compared.
	 */
	changeToken?(): Promise<string | undefined>;
	/** Every listed run with its latest event; a run with no events has version `{ seq: 0, at: 0 }`. */
	runVersions?(): Promise<ReadonlyMap<string, RunVersion>>;
	/** Undefined for a run with no snapshot event. */
	snapshotTail?(runId: string): Promise<RunSnapshotTail | undefined>;
	/**
	 * Content-addressed blobs for worktree snapshots recorded on checkpoints, in the journal's own storage. Absent when
	 * the journal cannot hold them; snapshots are then not recorded.
	 */
	readonly snapshotBlobs?: SnapshotBlobStore;
	/** Optional batched appends to one run in one transaction; each append is settled on its own, in order. */
	appendMany?(
		lease: Lease,
		appends: readonly RunJournalBatchAppend[],
	): Promise<readonly PromiseSettledResult<AppendOutcome>[]>;
	/**
	 * Optional atomic creation of a run together with its first events, as sequences 1..n, in one transaction:
	 * afterwards the run either exists with exactly these events or was not written at all. The run is created
	 * without a lease. Resolves "exists", writing nothing, when the run id is taken. `forkRun` requires it.
	 */
	createRunWithEvents?(header: RunHeader, events: readonly RunJournalSeedEvent[]): Promise<"created" | "exists">;
}

// Large journal payloads (#4965). Kept in this module, which every storage entry already loads, rather than a module of
// their own: the vitest setup's import graph has a fixed budget (test/unit/test-setup-import-graph.test.ts).

/**
 * The most bytes of JSON one row holds for a workflow journal event payload, a pool work item's inputs or a pool
 * result. A longer one is stored as rows of at most this many bytes of its UTF-8, written in the transaction that writes
 * it (#4965). Like the session entry chunks it stays well under the smallest backend limit, sqld's 5,000,000 bytes per
 * value and per row, and a chunk read stays under its 10 MB response limit.
 */
export const STORED_JSON_CHUNK_BYTES = 1024 * 1024;

/**
 * The most characters of one top-level field of a large event payload its stub keeps inline. The fields SQL reads from a
 * payload (`kind`, `status`, `workflowId`, `completedAt` and the like) are scalars far below this.
 */
const STUB_FIELD_CHARS = 4096;
/** The most characters of fields a stub keeps besides `worktreeSnapshots`. */
const STUB_CHARS = 64 * 1024;
/** Kept in a stub whatever its size: the snapshot reference index reads it whole. */
const STUB_KEPT_FIELDS: ReadonlySet<string> = new Set(["worktreeSnapshots"]);

/** The UTF-8 chunks of `json` when it is longer than one chunk, or undefined when one row holds it. */
export function storedJsonChunks(json: string): Uint8Array[] | undefined {
	// Every UTF-16 code unit is at most three bytes of UTF-8, so short JSON needs no encoding to be measured.
	if (json.length * 3 <= STORED_JSON_CHUNK_BYTES) return undefined;
	const bytes = Buffer.from(json, "utf8");
	if (bytes.byteLength <= STORED_JSON_CHUNK_BYTES) return undefined;
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += STORED_JSON_CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, offset + STORED_JSON_CHUNK_BYTES));
	}
	return chunks;
}

/**
 * The JSON text of `count` chunks, read one statement each: `sql` selects a chunk's `data` given `params` and the
 * chunk's index as its last parameter. `what` names the value in the error a missing chunk raises.
 */
export async function readStoredJsonChunks(
	executor: SqliteExecutor,
	sql: string,
	params: readonly SqliteValue[],
	count: number,
	what: string,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	for (let index = 0; index < count; index++) {
		const chunk = await executor.get<SqliteRow & { data: Uint8Array }>(sql, ...params, index);
		if (chunk === undefined) throw new StorageError(`${what} is missing chunk ${index} of ${count}`);
		chunks.push(chunk.data);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * What the events row of a payload stored in chunks holds instead of it: the payload's top-level fields that are short,
 * and `worktreeSnapshots` whole, so every SQL that reads a payload's JSON (the snapshot reference index, the run's
 * snapshot tail, status reads) reads the same values from it. A payload that is not an object has `null`.
 */
export function journalPayloadStub(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "null";
	const stub: Record<string, unknown> = {};
	let chars = 0;
	for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
		if (field === undefined) continue;
		if (STUB_KEPT_FIELDS.has(key)) {
			stub[key] = field;
			continue;
		}
		const json = JSON.stringify(field);
		if (json === undefined || json.length > STUB_FIELD_CHARS || chars + json.length > STUB_CHARS) continue;
		chars += json.length;
		stub[key] = field;
	}
	return JSON.stringify(stub);
}

/** A journal event payload as its events row and its chunk rows store it. */
export interface StoredJournalPayload {
	/** The `payload` column: the JSON itself, or its stub when it is stored in chunks. */
	readonly payload: string;
	/** The chunks of the JSON, none when the row holds it. */
	readonly chunks: readonly Uint8Array[];
}

/** How a journal event payload whose JSON is `json` is stored; `value` is the parsed payload, when the caller has it. */
export function storedJournalPayload(json: string, value?: unknown): StoredJournalPayload {
	const chunks = storedJsonChunks(json);
	if (chunks === undefined) return { payload: json, chunks: [] };
	return { payload: journalPayloadStub(value === undefined ? JSON.parse(json) : value), chunks };
}

/**
 * Writes the chunks of the event `seq` of `runId` into `table`, the journal's event chunks table, replacing any that a
 * deleted event with the same sequence left. Nothing for an event stored whole.
 */
export async function writeJournalPayloadChunks(
	tx: SqliteExecutor,
	table: string,
	runId: string,
	seq: number,
	chunks: readonly Uint8Array[],
): Promise<void> {
	if (chunks.length === 0) return;
	await tx.run(`DELETE FROM ${table} WHERE run_id = ? AND seq = ?`, runId, seq);
	for (const [index, data] of chunks.entries())
		await tx.run(`INSERT INTO ${table} (run_id, seq, idx, data) VALUES (?, ?, ?, ?)`, runId, seq, index, data);
}

/** An events row with its payload, and how many chunks hold it (absent or 0: the row holds it). */
export type JournalPayloadRow = SqliteRow & {
	readonly run_id: string;
	readonly seq: number | bigint;
	payload: string;
	chunks?: number | bigint | null;
};

/**
 * `rows` with the payload of each one stored in chunks read from `table`, the journal's event chunks table, and its
 * `chunks` set to 0, so a caller reads every row's payload the same way. Rows stored whole are returned as they are.
 */
export async function withJournalPayloads<Row extends JournalPayloadRow>(
	executor: SqliteExecutor,
	table: string,
	rows: readonly Row[],
): Promise<Row[]> {
	const loaded: Row[] = [];
	for (const row of rows) {
		const count = Number(row.chunks ?? 0);
		if (count === 0) {
			loaded.push(row);
			continue;
		}
		const payload = await readStoredJsonChunks(
			executor,
			`SELECT data FROM ${table} WHERE run_id = ? AND seq = ? AND idx = ?`,
			[row.run_id, Number(row.seq)],
			count,
			`Workflow run ${row.run_id} event ${row.seq}`,
		);
		loaded.push({ ...row, payload, chunks: 0 });
	}
	return loaded;
}

/**
 * How long after its last renewal a lease, or after its last report a worker host, counts as live for
 * {@link olderBuildLive}: past the windows in which either renews.
 */
export const OLDER_BUILD_LIVE_MS = 120_000;
/** The lease holder prefix of a journal store consolidation, which copies events whole and never reads chunks. */
const CONSOLIDATION_HOLDER = "atomic-storage-consolidate:";

/**
 * Whether a process of an older build may be reading the journal whose tables are `tables` right now, as far as it
 * can be told (#4965). A process that opened the journal before this build upgraded it never reads its schema version
 * again, so it would read a payload stored in chunks as its stub; while one is live, payloads are stored whole. It is
 * live when it holds a lease renewed within {@link OLDER_BUILD_LIVE_MS} that no build of this version granted (each
 * grant records its build in the lease builds table), or reports as a worker host within that window without the
 * journal schema version its build reads. Other older processes, such as one only reading, cannot be told apart.
 */
export async function olderBuildLive(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	tables: { readonly runs: string; readonly leases: string; readonly leaseBuilds: string },
): Promise<boolean> {
	const lease = await executor.get(
		`SELECT 1 AS live FROM ${tables.leases} AS l
		WHERE l.holder_id IS NOT NULL AND l.renewed_at > ${dialect.nowMs} - ? AND substr(l.holder_id, 1, ?) <> ?
		AND NOT EXISTS (
			SELECT 1 FROM ${tables.leaseBuilds} AS b
			WHERE b.run_id = l.run_id AND b.holder_id = l.holder_id AND b.epoch = l.epoch AND b.schema_version >= ?
		) LIMIT 1`,
		OLDER_BUILD_LIVE_MS,
		CONSOLIDATION_HOLDER.length,
		CONSOLIDATION_HOLDER,
		RUN_JOURNAL_SCHEMA_VERSION,
	);
	if (lease !== undefined) return true;
	const hosts = `${tables.runs}_pool_hosts`;
	const exists = dialect.tableExists(hosts);
	if ((await executor.get(exists.sql, ...exists.params)) === undefined) return false;
	const recorded = dialect.columnExists(hosts, "journal_schema");
	const known = (await executor.get(recorded.sql, ...recorded.params)) !== undefined;
	const host = await executor.get(
		`SELECT 1 AS live FROM ${hosts} WHERE heartbeat_at > ${dialect.nowMs} - ?${
			known ? " AND (journal_schema IS NULL OR journal_schema < ?)" : ""
		} LIMIT 1`,
		OLDER_BUILD_LIVE_MS,
		...(known ? [RUN_JOURNAL_SCHEMA_VERSION] : []),
	);
	return host !== undefined;
}
