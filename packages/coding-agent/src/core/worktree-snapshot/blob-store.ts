import type { SqliteDatabase, SqliteExecutor, SqliteRow, StorageDescriptor } from "../storage/database.js";
import { renderStorageIdentifiers, validateStoragePrefix } from "../storage/prefix.js";
import type { WorkspaceCollectionError } from "./errors.ts";
import type { SnapshotBlob, SnapshotBlobStore, WorktreeSnapshot } from "./types.ts";

/** Every blob hash a snapshot needs to be restored: its chain's patches and its bundle. */
export function snapshotBlobHashes(snapshot: WorktreeSnapshot): string[] {
	const hashes = snapshot.chain.flatMap((link) => (link.patch === null ? [] : [link.patch]));
	if (snapshot.bundle) hashes.push(snapshot.bundle.blob);
	return [...new Set(hashes)];
}

export class MemorySnapshotBlobStore implements SnapshotBlobStore {
	private readonly blobs = new Map<string, Uint8Array>();

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		for (const blob of blobs) if (!this.blobs.has(blob.hash)) this.blobs.set(blob.hash, Uint8Array.from(blob.data));
	}
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const data = this.blobs.get(hash);
		return data === undefined ? undefined : Uint8Array.from(data);
	}
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		return hashes.every((hash) => this.blobs.has(hash));
	}
	async listBlobHashes(): Promise<readonly string[]> {
		return [...this.blobs.keys()];
	}
}

/**
 * The tables of one blob table's reference index, all under the blob table's prefix. Triggers on the run journal's
 * and the session store's tables keep them current in the same transaction as each write, so collection reads only
 * these tables and never a journal or a session.
 */
export interface SnapshotIndexTables {
	readonly blobs: string;
	/** `(run_id, hash)`: each blob a run's tool or stage checkpoints reference, once per run. */
	readonly runRefs: string;
	/** `(run_id, retained, seq)`: whether the run's latest status keeps its snapshots, from the event at `seq`. */
	readonly runState: string;
	/** `(session_id, seq, root, snapshot_id)`: one row per `worktree_snapshot` session entry. */
	readonly sessionRefs: string;
	/** `(session_id, seq, snapshot_id, hash)`: the blobs of each snapshot record a session entry carries. */
	readonly sessionRecords: string;
	/** One row: the last collection's claim on the database clock and its outcome. */
	readonly collection: string;
	/** `(source, watermark, backfilled_through)`: how far the index covers each table that holds references. */
	readonly sources: string;
}

export function snapshotIndexTables(prefix = ""): SnapshotIndexTables {
	const p = validateStoragePrefix(prefix);
	return Object.freeze({
		blobs: `${p}snapshot_blobs`,
		runRefs: `${p}snapshot_run_refs`,
		runState: `${p}snapshot_run_state`,
		sessionRefs: `${p}snapshot_session_refs`,
		sessionRecords: `${p}snapshot_session_records`,
		collection: `${p}snapshot_collection`,
		sources: `${p}snapshot_index_sources`,
	});
}

export type SnapshotCollectionSkipReason = "disabled" | "unsupported" | "in-progress" | "not-due";

/** How one automatic collection ended. Its promise never rejects: a failure is an outcome, reported once. */
export type SnapshotCollectionOutcome =
	| { readonly status: "skipped"; readonly reason: SnapshotCollectionSkipReason }
	| { readonly status: "collected"; readonly deleted: readonly string[] }
	/** The storage closed before the collection finished; what it deleted stays deleted. */
	| { readonly status: "interrupted"; readonly deleted: readonly string[] }
	| { readonly status: "failed"; readonly error: WorkspaceCollectionError };

/** The prefix of every blob table identity in one database, for telling the tables of one database apart. */
const databaseIdentity = (descriptor: StorageDescriptor) => `${descriptor.adapter}\0${descriptor.location}\0`;

const collectionsRunning = new Map<string, Promise<SnapshotCollectionOutcome>>();

/** Records the automatic collection this process runs on `store`'s blob table, until it settles. */
export function trackSnapshotCollection(
	store: SqlSnapshotBlobStore,
	running: Promise<SnapshotCollectionOutcome>,
): void {
	collectionsRunning.set(store.identity, running);
	void running.then(() => collectionsRunning.delete(store.identity));
}

/** The automatic collection of `store`'s blob table that this process is running, if any. */
export function runningSnapshotCollectionOf(
	store: SqlSnapshotBlobStore,
): Promise<SnapshotCollectionOutcome> | undefined {
	return collectionsRunning.get(store.identity);
}

/** Every automatic collection this process is running on a blob table of the database `descriptor` names. */
export function runningSnapshotCollectionsOn(descriptor: StorageDescriptor): Promise<SnapshotCollectionOutcome>[] {
	const prefix = databaseIdentity(descriptor);
	return [...collectionsRunning].filter(([identity]) => identity.startsWith(prefix)).map(([, running]) => running);
}

/** Blobs one collection batch examines and deletes in one write transaction. */
export const SNAPSHOT_COLLECTION_BATCH = 256;

/** Rows of one referencing table that one backfill transaction indexes. */
export const SNAPSHOT_INDEX_BACKFILL_BATCH = 500;

/**
 * How long an unfinished collection's claim holds the database after its last batch, in seconds. Every batch renews
 * it, so a collection that stopped (killed, or its storage closed) is taken over after this lease, not after the
 * collection interval.
 */
export const SNAPSHOT_COLLECTION_LEASE_SECONDS = 120;

export interface SnapshotIndexOptions {
	readonly signal?: AbortSignal;
	/** Renews this holder's claim in every batch, so a long collection keeps it. */
	readonly holder?: string;
}

export interface SnapshotSweepOptions extends SnapshotIndexOptions {
	readonly graceSeconds: number;
	/** Called after each batch commits with the hashes it deleted. */
	readonly onBatch?: (deleted: readonly string[]) => void;
}

type PageRow = SqliteRow & { created_at: number; hash: string };

/**
 * A table whose rows reference snapshot blobs, with the triggers that index its future rows and the statements that
 * index the rows it already holds. Both are built from the same statements, so they cannot disagree.
 */
interface IndexSource {
	readonly name: string;
	readonly table: string;
	readonly triggers: readonly string[];
	readonly createTriggers: string;
	/** Each statement indexes the rows with `rowid > ? AND rowid <= ?`, bound in that order. */
	readonly backfill: readonly string[];
}

interface SourceState {
	readonly source: IndexSource;
	readonly installed: boolean;
	readonly backfilled: boolean;
}

const CHECKPOINT_EVENT = "CheckpointRecorded";
const STATUS_EVENTS = "'RunStarted', 'StatusChanged'";
const RELEASED_STATUSES = "'completed', 'cancelled'";
/** The `seq` of a run state taken from the run's header status, which any start or status event replaces. */
const HEADER_SEQ = -1;

type Column = (name: string) => string;
const newRow: Column = (name) => `NEW.${name}`;
const storedRow: Column = (name) => name;

/** `test` on a payload that may not be JSON: SQLite does not promise to stop at the first false term of an AND. */
const whenValidJson = (json: string, test: string) => `CASE WHEN json_valid(${json}) THEN (${test}) ELSE 0 END`;

const triggerRows = (columns: readonly string[]) =>
	`(SELECT ${columns.map((name) => `NEW.${name} AS ${name}`).join(", ")})`;
const storedRows = (table: string, columns: readonly string[], condition: string) =>
	`(SELECT ${columns.join(", ")} FROM ${table} WHERE rowid > ? AND rowid <= ? AND ${condition})`;

function checkpointCondition(column: Column): string {
	const payload = column("payload");
	return `${column("type")} = '${CHECKPOINT_EVENT}' AND instr(${payload}, '"worktreeSnapshots"') > 0 AND ${whenValidJson(
		payload,
		`json_extract(${payload}, '$.kind') IN ('tool', 'stage')`,
	)}`;
}

function statusCondition(column: Column): string {
	const payload = column("payload");
	return `${column("type")} IN (${STATUS_EVENTS}) AND ${whenValidJson(
		payload,
		`json_type(${payload}, '$.workflowId') = 'text' AND json_type(${payload}, '$.status') = 'text' AND json_type(${payload}, '$.completedCheckpoints') IN ('integer', 'real') AND json_type(${payload}, '$.pendingPrompts') IN ('integer', 'real')`,
	)}`;
}

function snapshotEntryCondition(column: Column): string {
	const entry = column("entry_json");
	return `instr(${entry}, '"worktree_snapshot"') > 0 AND json_extract(${entry}, '$.type') = 'worktree_snapshot' AND json_type(${entry}, '$.root') = 'text' AND json_type(${entry}, '$.snapshotId') = 'text'`;
}

/**
 * The SQL form of `isDurableWorkflowResumable` for the status payload `payload`, given that the run has a snapshot
 * reference and so at least one checkpoint: a root run keeps its snapshots while it is failed or blocked, or running or
 * paused, unless it was marked not resumable.
 */
function retainedByStatus(payload: string): string {
	const root = `json_type(${payload}, '$.rootWorkflowId')`;
	return `CASE
		WHEN ${root} IS NOT NULL AND (${root} <> 'text' OR json_extract(${payload}, '$.rootWorkflowId') <> json_extract(${payload}, '$.workflowId')) THEN 0
		WHEN json_extract(${payload}, '$.status') IN ('failed', 'blocked', 'running', 'paused') THEN json_type(${payload}, '$.resumable') IS NOT 'false'
		ELSE 0
	END`;
}

function createTrigger(name: string, event: string, table: string, body: readonly string[], when?: string): string {
	return `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when === undefined ? "" : ` WHEN ${when}`} BEGIN ${body.join("; ")}; END;`;
}

function indexSources(prefix: string, t: SnapshotIndexTables): readonly IndexSource[] {
	const { events, runs } = renderStorageIdentifiers("journal", { events: "events", runs: "runs" }, prefix);
	const { entries } = renderStorageIdentifiers("sessions", { entries: "entries" }, prefix);

	const runRefs = (rows: string) =>
		[
			{
				from: `json_each(r.payload, '$.worktreeSnapshots') AS snapshot, json_each(r.payload, snapshot.fullkey || '.chain') AS link`,
				hash: `json_extract(r.payload, link.fullkey || '.patch')`,
			},
			{
				from: `json_each(r.payload, '$.worktreeSnapshots') AS snapshot`,
				hash: `json_extract(r.payload, snapshot.fullkey || '.bundle.blob')`,
			},
		].map(
			({ from, hash }) =>
				`INSERT OR IGNORE INTO ${t.runRefs} (run_id, hash) SELECT r.run_id, ${hash} FROM ${rows} AS r, ${from} WHERE typeof(${hash}) = 'text'`,
		);
	const runState = (rows: string) =>
		`INSERT INTO ${t.runState} (run_id, retained, seq) SELECT r.run_id, ${retainedByStatus("r.payload")}, r.seq FROM ${rows} AS r WHERE true ON CONFLICT (run_id) DO UPDATE SET retained = excluded.retained, seq = excluded.seq WHERE excluded.seq >= ${t.runState}.seq`;
	const runHeader = (rows: string) =>
		`INSERT INTO ${t.runState} (run_id, retained, seq) SELECT r.run_id, r.status NOT IN (${RELEASED_STATUSES}), ${HEADER_SEQ} FROM ${rows} AS r WHERE true ON CONFLICT (run_id) DO NOTHING`;
	const sessionRefs = (rows: string) => {
		const record = (hash: string, from = "") =>
			`INSERT OR IGNORE INTO ${t.sessionRecords} (session_id, seq, snapshot_id, hash) SELECT r.session_id, r.seq, json_extract(r.entry_json, '$.snapshotId'), ${hash} FROM ${rows} AS r${from} WHERE typeof(${hash}) = 'text'`;
		return [
			`INSERT OR REPLACE INTO ${t.sessionRefs} (session_id, seq, root, snapshot_id) SELECT r.session_id, r.seq, json_extract(r.entry_json, '$.root'), json_extract(r.entry_json, '$.snapshotId') FROM ${rows} AS r`,
			record(
				`json_extract(r.entry_json, link.fullkey || '.patch')`,
				`, json_each(r.entry_json, '$.snapshot.chain') AS link`,
			),
			record(`json_extract(r.entry_json, '$.snapshot.bundle.blob')`),
		];
	};

	const eventColumns = ["run_id", "seq", "payload"];
	const eventsSource = {
		name: "journal-events",
		table: events,
		triggers: [`${events}_snapshot_refs`, `${events}_snapshot_state`],
		createTriggers: [
			createTrigger(
				`${events}_snapshot_refs`,
				"INSERT",
				events,
				runRefs(triggerRows(eventColumns)),
				checkpointCondition(newRow),
			),
			createTrigger(
				`${events}_snapshot_state`,
				"INSERT",
				events,
				[runState(triggerRows(eventColumns))],
				statusCondition(newRow),
			),
		].join("\n"),
		backfill: [
			...runRefs(storedRows(events, eventColumns, checkpointCondition(storedRow))),
			runState(storedRows(events, eventColumns, statusCondition(storedRow))),
		],
	};
	const headerColumns = ["run_id", "status"];
	const runsSource = {
		name: "journal-runs",
		table: runs,
		triggers: [`${runs}_snapshot_state_insert`, `${runs}_snapshot_state_status`, `${runs}_snapshot_refs_delete`],
		createTriggers: [
			createTrigger(`${runs}_snapshot_state_insert`, "INSERT", runs, [runHeader(triggerRows(headerColumns))]),
			createTrigger(`${runs}_snapshot_state_status`, "UPDATE OF status", runs, [
				`UPDATE ${t.runState} SET retained = NEW.status NOT IN (${RELEASED_STATUSES}) WHERE run_id = NEW.run_id AND seq = ${HEADER_SEQ}`,
			]),
			createTrigger(`${runs}_snapshot_refs_delete`, "DELETE", runs, [
				`DELETE FROM ${t.runRefs} WHERE run_id = OLD.run_id`,
				`DELETE FROM ${t.runState} WHERE run_id = OLD.run_id`,
			]),
		].join("\n"),
		backfill: [runHeader(storedRows(runs, headerColumns, "1"))],
	};
	const entryColumns = ["session_id", "seq", "entry_json"];
	const entriesSource = {
		name: "session-entries",
		table: entries,
		triggers: [`${entries}_snapshot_refs`, `${entries}_snapshot_refs_delete`],
		createTriggers: [
			createTrigger(
				`${entries}_snapshot_refs`,
				"INSERT",
				entries,
				sessionRefs(triggerRows(entryColumns)),
				snapshotEntryCondition(newRow),
			),
			createTrigger(`${entries}_snapshot_refs_delete`, "DELETE", entries, [
				`DELETE FROM ${t.sessionRefs} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
				`DELETE FROM ${t.sessionRecords} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
			]),
		].join("\n"),
		backfill: sessionRefs(storedRows(entries, entryColumns, snapshotEntryCondition(storedRow))),
	};
	return [eventsSource, runsSource, entriesSource];
}

/** Which referencing tables exist, whether each has all its triggers and a source row, and whether its backfill is done. */
async function readSourceStates(
	executor: SqliteExecutor,
	t: SnapshotIndexTables,
	sources: readonly IndexSource[],
): Promise<SourceState[]> {
	const names = sources.flatMap((source) => [source.table, ...source.triggers]);
	const present = new Set(
		(
			await executor.all<SqliteRow & { name: string }>(
				`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`,
				...names,
			)
		).map((row) => row.name),
	);
	const progress = new Map(
		(
			await executor.all<SqliteRow & { source: string; watermark: number; backfilled_through: number }>(
				`SELECT source, watermark, backfilled_through FROM ${t.sources}`,
			)
		).map((row) => [row.source, row]),
	);
	return sources
		.filter((source) => present.has(source.table))
		.map((source) => {
			const row = progress.get(source.name);
			return {
				source,
				installed: row !== undefined && source.triggers.every((name) => present.has(name)),
				backfilled: row !== undefined && Number(row.backfilled_through) >= Number(row.watermark),
			};
		});
}

/** The `<prefix>snapshot_blobs` table and its reference index, shared by the session store and run journal of one database. */
export class SqlSnapshotBlobStore implements SnapshotBlobStore {
	private readonly database: SqliteDatabase;
	private readonly tables: SnapshotIndexTables;
	private readonly sources: readonly IndexSource[];
	readonly table: string;

	private constructor(database: SqliteDatabase, tables: SnapshotIndexTables, sources: readonly IndexSource[]) {
		this.database = database;
		this.tables = tables;
		this.sources = sources;
		this.table = tables.blobs;
	}

	/** Which table this store collects, for telling stores of one database and prefix apart from others. */
	get identity(): string {
		return `${databaseIdentity(this.database.descriptor)}${this.table}`;
	}

	/**
	 * Opens the table, creating it in its own transaction when it is missing. A store that already has the table opens
	 * without taking the write lock.
	 */
	static async open(database: SqliteDatabase, prefix = ""): Promise<SqlSnapshotBlobStore> {
		const t = snapshotIndexTables(prefix);
		const exists = await database.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", t.sources);
		if (!exists) {
			await database.transaction(async (transaction) => {
				await transaction.exec(`
					CREATE TABLE IF NOT EXISTS ${t.blobs} (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())) STRICT;
					CREATE INDEX IF NOT EXISTS ${t.blobs}_age ON ${t.blobs} (created_at, hash);
					CREATE TABLE IF NOT EXISTS ${t.runRefs} (run_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (run_id, hash)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.runRefs}_hash ON ${t.runRefs} (hash);
					CREATE TABLE IF NOT EXISTS ${t.runState} (run_id TEXT PRIMARY KEY, retained INTEGER NOT NULL, seq INTEGER NOT NULL) STRICT, WITHOUT ROWID;
					CREATE TABLE IF NOT EXISTS ${t.sessionRefs} (session_id TEXT NOT NULL, seq INTEGER NOT NULL, root TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY (session_id, seq)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.sessionRefs}_root ON ${t.sessionRefs} (session_id, root, seq);
					CREATE INDEX IF NOT EXISTS ${t.sessionRefs}_snapshot ON ${t.sessionRefs} (session_id, snapshot_id);
					CREATE TABLE IF NOT EXISTS ${t.sessionRecords} (session_id TEXT NOT NULL, seq INTEGER NOT NULL, snapshot_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (session_id, seq, hash)) STRICT, WITHOUT ROWID;
					CREATE INDEX IF NOT EXISTS ${t.sessionRecords}_hash ON ${t.sessionRecords} (hash);
					CREATE TABLE IF NOT EXISTS ${t.collection} (id INTEGER PRIMARY KEY CHECK (id = 1), claimed_at INTEGER, holder TEXT, finished_at INTEGER, deleted INTEGER, error_code TEXT) STRICT;
					INSERT OR IGNORE INTO ${t.collection} (id) VALUES (1);
					CREATE TABLE IF NOT EXISTS ${t.sources} (source TEXT PRIMARY KEY, watermark INTEGER NOT NULL, backfilled_through INTEGER NOT NULL) STRICT, WITHOUT ROWID;
				`);
			});
		}
		const store = new SqlSnapshotBlobStore(database, t, indexSources(prefix, t));
		await store.installIndex();
		return store;
	}

	/**
	 * Creates the table inside the caller's transaction, so a store that creates its own tables, such as a new run
	 * journal, takes the write lock once for both.
	 */
	static async initialize(transaction: SqliteExecutor, prefix = ""): Promise<void> {
		await transaction.exec(
			`CREATE TABLE IF NOT EXISTS ${validateStoragePrefix(prefix)}snapshot_blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())) STRICT`,
		);
	}

	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		if (blobs.length === 0) return;
		const sql = `INSERT INTO ${this.table} (hash, bytes, data) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET created_at = unixepoch()`;
		const statements = blobs.map((blob) => ({ sql, params: [blob.hash, blob.data.byteLength, blob.data] }));
		if (this.database.batch) {
			await this.database.batch(statements);
			return;
		}
		await this.database.transaction(async (transaction) => {
			for (const statement of statements) await transaction.run(statement.sql, ...statement.params);
		});
	}
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const row = await this.database.get<{ data: Uint8Array }>(`SELECT data FROM ${this.table} WHERE hash = ?`, hash);
		return row?.data;
	}
	/** Restarts the age of every stored hash in one statement on the database clock; false when any is missing. */
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		const unique = [...new Set(hashes)];
		if (unique.length === 0) return true;
		const { changes } = await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.table} SET created_at = unixepoch() WHERE hash IN (SELECT value FROM json_each(?))`,
				JSON.stringify(unique),
			),
		);
		return changes === unique.length;
	}
	async listBlobHashes(): Promise<readonly string[]> {
		const rows = await this.database.all<{ hash: string }>(`SELECT hash FROM ${this.table}`);
		return rows.map((row) => row.hash);
	}

	/**
	 * Installs the index triggers of every referencing table that lacks them, each with a watermark, the highest rowid
	 * the table holds in the same transaction, so every row is either at or below the watermark, to be backfilled, or
	 * above it, indexed by the triggers. A table that has none yet, an empty one included, costs one watermark of 0.
	 * Resolves with the state of every referencing table.
	 */
	private async installIndex(): Promise<SourceState[]> {
		const states = await readSourceStates(this.database, this.tables, this.sources);
		const missing = states.filter((state) => !state.installed);
		for (const { source } of missing) {
			await this.database.transaction(async (transaction) => {
				const [current] = await readSourceStates(transaction, this.tables, [source]);
				if (current === undefined || current.installed) return;
				await transaction.exec(source.createTriggers);
				await transaction.run(
					`INSERT OR REPLACE INTO ${this.tables.sources} (source, watermark, backfilled_through) SELECT ?, COALESCE(MAX(rowid), 0), 0 FROM ${source.table}`,
					source.name,
				);
			});
		}
		return missing.length === 0 ? states : readSourceStates(this.database, this.tables, this.sources);
	}

	/**
	 * Indexes the rows that referencing tables held before their triggers were installed, in transactions of
	 * {@link SNAPSHOT_INDEX_BACKFILL_BATCH} rows, so that the index covers every reference. A one-time cost in the number
	 * of existing rows, paid in the background by the first collection; resumes where it stopped. Does nothing once the
	 * index is complete. Checks `signal` before each batch and rejects with its reason.
	 */
	async completeIndex(options: SnapshotIndexOptions = {}): Promise<void> {
		for (const { source, backfilled } of await this.installIndex()) {
			if (backfilled) continue;
			for (;;) {
				options.signal?.throwIfAborted();
				if (await this.backfillBatch(source, options.holder)) break;
			}
		}
	}

	/** Indexes the next rows of `source`, and resolves true once every row at or below its watermark is indexed. */
	private backfillBatch(source: IndexSource, holder: string | undefined): Promise<boolean> {
		const t = this.tables;
		return this.database.transaction(async (transaction) => {
			const progress = await transaction.get<SqliteRow & { watermark: number; backfilled_through: number }>(
				`SELECT watermark, backfilled_through FROM ${t.sources} WHERE source = ?`,
				source.name,
			);
			if (progress === undefined || progress.backfilled_through >= progress.watermark) return true;
			const { upper: lastRow } = (await transaction.get<SqliteRow & { upper: number | null }>(
				`SELECT MAX(rowid) AS upper FROM (SELECT rowid FROM ${source.table} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?)`,
				progress.backfilled_through,
				progress.watermark,
				SNAPSHOT_INDEX_BACKFILL_BATCH,
			))!;
			const upper = lastRow ?? progress.watermark;
			for (const sql of source.backfill) await transaction.run(sql, progress.backfilled_through, upper);
			await transaction.run(`UPDATE ${t.sources} SET backfilled_through = ? WHERE source = ?`, upper, source.name);
			if (holder !== undefined) await this.renewClaim(transaction, holder);
			return upper >= progress.watermark;
		});
	}

	/**
	 * Deletes every blob stored or re-stored at least `graceSeconds` ago on the database clock that no retained snapshot
	 * references, in batches of {@link SNAPSHOT_COLLECTION_BATCH}, and resolves with the hashes deleted. Each batch is
	 * one write transaction whose delete re-checks age and references in the same statement, so a reference published
	 * before the batch commits keeps its blob and a process killed mid-collection leaves only garbage. Reads the
	 * reference index and the blob table's age index, never a journal or a session.
	 *
	 * Every batch first checks, in its own transaction, that every referencing table has its triggers and a finished
	 * backfill, as {@link completeIndex} leaves them. When one does not, because a table appeared or lost its triggers
	 * since, nothing is deleted until the index has been completed again. A sweep repairs the index once; when it is
	 * incomplete again after that, because the schema keeps changing under it, the sweep stops without deleting
	 * anything more and the next collection tries again. Checks `signal` before each batch and rejects with its
	 * reason.
	 */
	async sweep(options: SnapshotSweepOptions): Promise<readonly string[]> {
		const t = this.tables;
		const unreferenced = `NOT EXISTS (
				SELECT 1 FROM ${t.runRefs} AS ref WHERE ref.hash = ${t.blobs}.hash
				AND NOT EXISTS (SELECT 1 FROM ${t.runState} AS state WHERE state.run_id = ref.run_id AND state.retained = 0)
			) AND NOT EXISTS (
				SELECT 1 FROM ${t.sessionRecords} AS record
				JOIN ${t.sessionRefs} AS head ON head.session_id = record.session_id AND head.snapshot_id = record.snapshot_id
				WHERE record.hash = ${t.blobs}.hash AND head.seq = (
					SELECT max(latest.seq) FROM ${t.sessionRefs} AS latest WHERE latest.session_id = head.session_id AND latest.root = head.root
				)
			)`;
		const deleted: string[] = [];
		let cursor: PageRow | undefined;
		let repaired = false;
		for (;;) {
			options.signal?.throwIfAborted();
			const after = cursor;
			const batch = await this.database.transaction(async (transaction) => {
				const states = await readSourceStates(transaction, this.tables, this.sources);
				if (!states.every((state) => state.installed && state.backfilled)) return undefined;
				if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
				const page = await this.page(transaction, options.graceSeconds, after);
				if (page.length === 0) return { page, deleted: [] };
				const rows = await transaction.all<SqliteRow & { hash: string }>(
					`DELETE FROM ${t.blobs} WHERE hash IN (SELECT value FROM json_each(?)) AND created_at <= unixepoch() - ? AND ${unreferenced} RETURNING hash`,
					JSON.stringify(page.map((row) => row.hash)),
					options.graceSeconds,
				);
				return { page, deleted: rows.map((row) => row.hash) };
			});
			if (batch === undefined) {
				if (repaired) return deleted;
				repaired = true;
				await this.completeIndex(options);
				continue;
			}
			deleted.push(...batch.deleted);
			options.onBatch?.(batch.deleted);
			if (batch.page.length < SNAPSHOT_COLLECTION_BATCH) return deleted;
			cursor = batch.page.at(-1);
		}
	}

	/** {@link completeIndex}, then {@link sweep}: what a manual collection does. */
	async collectGarbage(options: SnapshotSweepOptions): Promise<readonly string[]> {
		await this.completeIndex(options);
		return this.sweep(options);
	}

	private page(transaction: SqliteExecutor, graceSeconds: number, after: PageRow | undefined): Promise<PageRow[]> {
		const t = this.tables;
		return after === undefined
			? transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at <= unixepoch() - ? ORDER BY created_at, hash LIMIT ?`,
					graceSeconds,
					SNAPSHOT_COLLECTION_BATCH,
				)
			: transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at <= unixepoch() - ? AND (created_at, hash) > (?, ?) ORDER BY created_at, hash LIMIT ?`,
					graceSeconds,
					after.created_at,
					after.hash,
					SNAPSHOT_COLLECTION_BATCH,
				);
	}

	/**
	 * Claims this table's next collection for `holder` when it is due on the database clock: none was ever claimed, or
	 * the last one finished at least `intervalSeconds` ago, or an unfinished one has renewed its claim in no batch for
	 * {@link SNAPSHOT_COLLECTION_LEASE_SECONDS}, so it stopped. A failed collection finishes with its error code, so it
	 * backs off for the whole interval. A read without the write lock answers "not due" first; only a due claim takes
	 * the lock.
	 */
	async claimCollection(intervalSeconds: number, holder: string): Promise<boolean> {
		const due = `id = 1 AND (claimed_at IS NULL OR (finished_at IS NULL AND claimed_at <= unixepoch() - ?) OR (finished_at IS NOT NULL AND finished_at <= unixepoch() - ?))`;
		const lease = SNAPSHOT_COLLECTION_LEASE_SECONDS;
		if (!(await this.database.get(`SELECT id FROM ${this.tables.collection} WHERE ${due}`, lease, intervalSeconds)))
			return false;
		const { changes } = await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET claimed_at = unixepoch(), holder = ?, finished_at = NULL, deleted = NULL, error_code = NULL WHERE ${due}`,
				holder,
				lease,
				intervalSeconds,
			),
		);
		return changes === 1;
	}

	private renewClaim(transaction: SqliteExecutor, holder: string): Promise<unknown> {
		return transaction.run(
			`UPDATE ${this.tables.collection} SET claimed_at = unixepoch() WHERE id = 1 AND holder = ?`,
			holder,
		);
	}

	/** Records how `holder`'s claimed collection ended; a later claim by another holder is left alone. */
	async recordCollection(
		holder: string,
		outcome: { readonly deleted: number; readonly errorCode: string | null },
	): Promise<void> {
		await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET finished_at = unixepoch(), deleted = ?, error_code = ? WHERE id = 1 AND holder = ?`,
				outcome.deleted,
				outcome.errorCode,
				holder,
			),
		);
	}
}
