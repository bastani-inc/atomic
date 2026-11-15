import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue, StorageDescriptor } from "../storage/database.js";
import { dialectOf, type StorageDialect, type StorageJsonSource, type StorageTrigger } from "../storage/dialect.js";
import { StorageWriteLockTimeoutError } from "../storage/errors.js";
import { applyStorageMigrations } from "../storage/migrations.js";
import { renderStorageIdentifiers, storageMigrationTable, validateStoragePrefix } from "../storage/prefix.js";
import { type WorkspaceCollectionError, WorkspaceSnapshotError } from "./errors.ts";
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
	/**
	 * `(hash, bytes, data, created_at, chunks)`: one row per blob. A blob of at most {@link SNAPSHOT_BLOB_CHUNK_BYTES}
	 * is in `data` (`chunks` 0, as every blob written before chunks was); a larger one has an empty `data` and its bytes
	 * in `chunks` rows of {@link SnapshotIndexTables.blobChunks}.
	 */
	readonly blobs: string;
	/** `(hash, idx, data)`: the chunks of each blob larger than {@link SNAPSHOT_BLOB_CHUNK_BYTES}, in order (#4954). */
	readonly blobChunks: string;
	/** `(run_id, hash)`: each blob a run's tool or stage checkpoints reference, once per run. */
	readonly runRefs: string;
	/** `(run_id, retained, seq)`: whether the run's latest status keeps its snapshots, from the event at `seq`. */
	readonly runState: string;
	/**
	 * `(session_id, seq, root, snapshot_id, prev_seq, restore_from, restore_to, degraded_from, degraded_since)`: one row
	 * per `worktree_snapshot` session entry, with the `seq` of the nearest snapshot entry before it on its branch and,
	 * for the entry written when a snapshot was restored into a new worktree, the root it moved from and to. An entry of
	 * a partly restored worktree names the snapshot it lacks in `degraded_from` (#4922), with `degraded_since`, on the
	 * database clock, when the entries naming it began: the nearest snapshot entry before it's when that one names it
	 * too, else when this entry was indexed.
	 */
	readonly sessionRefs: string;
	/**
	 * `(session_id, seq, entry_id, parent_id, anchor_seq, children, broken)`: one row per session entry, so that a
	 * branch can be followed without reading entries: `anchor_seq` is the latest snapshot entry at or before the entry
	 * on its branch, `children` counts its child entries (none: a leaf of the session tree), and `broken` marks an
	 * entry whose parent the index could not follow, which makes the session keep every snapshot it records.
	 */
	readonly sessionLinks: string;
	/** `(session_id, seq, snapshot_id, hash)`: the blobs of each snapshot record a session entry carries. */
	readonly sessionRecords: string;
	/**
	 * `(owner, hash)`: the blobs of each snapshot that dispatched work carries (#4503), once per row that carries it: a
	 * pool work row (owner `work:<id>`) or a root's pool binding (owner `root:<run id>`). A reference lasts as long as its
	 * row, whatever any run's status.
	 */
	readonly carriedRefs: string;
	/** One row: the last collection's claim on the database clock and its outcome. */
	readonly collection: string;
	/** `(source, watermark, backfilled_through)`: how far the index covers each table that holds references. */
	readonly sources: string;
}

export function snapshotIndexTables(prefix = ""): SnapshotIndexTables {
	const p = validateStoragePrefix(prefix);
	return Object.freeze({
		blobs: `${p}snapshot_blobs`,
		blobChunks: `${p}snapshot_blob_chunks`,
		runRefs: `${p}snapshot_run_refs`,
		runState: `${p}snapshot_run_state`,
		sessionRefs: `${p}snapshot_session_refs`,
		sessionLinks: `${p}snapshot_session_links`,
		sessionRecords: `${p}snapshot_session_records`,
		carriedRefs: `${p}snapshot_carried_refs`,
		collection: `${p}snapshot_collection`,
		sources: `${p}snapshot_index_sources`,
	});
}

/**
 * The most bytes of a snapshot blob one row holds. A larger blob, such as the patch of a checkout with a large
 * untracked file, is stored as rows of at most this size, written in one transaction: a libSQL server refuses a value
 * or row over 5,000,000 bytes by default (sqld's `max_row_size`) and a response over 10 MB, so one row per blob failed
 * on it below the documented `maxFileBytes` (#4954). A different size needs a different table name, because a blob's
 * rows are addressed by their index.
 */
export const SNAPSHOT_BLOB_CHUNK_BYTES = 1024 * 1024;

/** The schema domain of the blob table and its reference index, in the prefix's migration ledger. */
export const SNAPSHOT_BLOB_DOMAIN = "snapshot-blobs";

export type SnapshotCollectionSkipReason = "disabled" | "unsupported" | "in-progress" | "not-due";

/** How one automatic collection ended. Its promise never rejects: a failure is an outcome, reported once. */
export type SnapshotCollectionOutcome =
	| { readonly status: "skipped"; readonly reason: SnapshotCollectionSkipReason }
	| { readonly status: "collected"; readonly deleted: readonly string[] }
	/**
	 * The storage closed, or its last store was released, before the collection finished; it stopped at its next batch
	 * and what it deleted stays deleted.
	 */
	| { readonly status: "interrupted"; readonly deleted: readonly string[] }
	| { readonly status: "failed"; readonly error: WorkspaceCollectionError };

/** The prefix of every blob table identity in one database, for telling the tables of one database apart. */
const databaseIdentity = (descriptor: StorageDescriptor) => `${descriptor.adapter}\0${descriptor.location}\0`;

/**
 * How an automatic collection waits, so that it never keeps its process alive: between batches, and before it tries
 * a write lock another connection holds again, on timers the process does not wait for. A process that has nothing
 * else to do exits at the next wait, which leaves only garbage, like a crash, and the next trigger after the claim
 * lease carries on. {@link keepProcessAlive} makes the process wait for the collection like any other work. A wait
 * ends at once when `signal` aborts, so an aborted collection stops without sleeping out its wait.
 */
export class BackgroundCollectionPace {
	readonly signal?: AbortSignal;
	private keepAlive = false;
	private pending?: ReturnType<typeof setTimeout>;

	constructor(signal?: AbortSignal) {
		this.signal = signal;
	}

	/**
	 * Resolves after `milliseconds`, or as soon as the signal aborts, and unless the process exits first because it
	 * has nothing else to do.
	 */
	wait(milliseconds: number): Promise<void> {
		return new Promise((resolve) => {
			const signal = this.signal;
			if (signal?.aborted) return resolve();
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				this.pending = undefined;
				resolve();
			};
			const timer = setTimeout(done, milliseconds);
			signal?.addEventListener("abort", done, { once: true });
			if (!this.keepAlive) timer.unref();
			this.pending = timer;
		});
	}

	/** Makes the process wait for the collection: the wait in progress and every later one. */
	keepProcessAlive(): void {
		this.keepAlive = true;
		this.pending?.ref();
	}
}

/** An automatic collection this process is running, and how it waits. */
export interface RunningSnapshotCollection {
	readonly outcome: Promise<SnapshotCollectionOutcome>;
	readonly pace: BackgroundCollectionPace;
	/** Stops the collection at its next batch boundary, with `reason` as the abort reason. */
	abort(reason: Error): void;
}

const collectionsRunning = new Map<string, RunningSnapshotCollection>();

/** Records the automatic collection this process runs on `store`'s blob table, until it settles. */
export function trackSnapshotCollection(store: SqlSnapshotBlobStore, running: RunningSnapshotCollection): void {
	collectionsRunning.set(store.identity, running);
	void running.outcome.then(() => collectionsRunning.delete(store.identity));
}

/** The automatic collection of `store`'s blob table that this process is running, if any. */
export function runningSnapshotCollectionOf(store: SqlSnapshotBlobStore): RunningSnapshotCollection | undefined {
	return collectionsRunning.get(store.identity);
}

/**
 * Stops every automatic collection this process is running on a blob table of the database `descriptor` names, each at
 * its next batch boundary, with `reason` as the abort reason; a collection that stops this way ends `interrupted`.
 */
export function abortSnapshotCollectionsOn(descriptor: StorageDescriptor, reason: Error): void {
	const prefix = databaseIdentity(descriptor);
	for (const [identity, running] of collectionsRunning) if (identity.startsWith(prefix)) running.abort(reason);
}

/** Every automatic collection this process is running on a blob table of the database `descriptor` names. */
export function runningSnapshotCollectionsOn(descriptor: StorageDescriptor): Promise<SnapshotCollectionOutcome>[] {
	const prefix = databaseIdentity(descriptor);
	return [...collectionsRunning]
		.filter(([identity]) => identity.startsWith(prefix))
		.map(([, running]) => running.outcome);
}

/**
 * Resolves after the event loop has run its timers and I/O callbacks. The node:sqlite adapter commits an uncontended
 * transaction without ever returning to the loop, so a collection yields here between batches instead of holding
 * the host process for all of them.
 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * How long the snapshot a resume restored only partly stays its checkout's restore target and is kept by collection
 * (#4922). Resume and capture count it from the partial restore; collection, on the database clock, from the first
 * session entry that names the snapshot, which never comes earlier.
 */
export const DEGRADED_RESTORE_RETENTION_DAYS = 30;
const DEGRADED_PIN_SECONDS = DEGRADED_RESTORE_RETENTION_DAYS * 24 * 60 * 60;

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

/**
 * How long a background collection first waits before it tries a write lock another connection holds again, in
 * milliseconds. Each refusal doubles the wait, up to {@link SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS}; once the waits add
 * up to the claim lease, the collection gives up with the lock's error, since another process may take over its claim.
 */
export const SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS = 10;
export const SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS = 1_000;

export interface SnapshotIndexOptions {
	readonly signal?: AbortSignal;
	/** Renews this holder's claim in every batch, so a long collection keeps it. */
	readonly holder?: string;
	/**
	 * Runs in the background: waits between batches, and for a write lock another connection holds, on `pace`, so the
	 * process can exit meanwhile. Without it the collection waits like any other work of its caller.
	 */
	readonly pace?: BackgroundCollectionPace;
}

export interface SnapshotSweepOptions extends SnapshotIndexOptions {
	readonly graceSeconds: number;
	/** Called after each batch commits with the hashes it deleted. */
	readonly onBatch?: (deleted: readonly string[]) => void;
}

type PageRow = SqliteRow & { created_at: number; hash: string };

/**
 * How many whole seconds a blob's `created_at` must lie behind the database clock for the blob to be at least
 * `graceSeconds` old. Both count whole seconds, so a blob stored late in a second carries that second's start and can
 * be almost a second younger than the difference says; one second more keeps it for the whole window. 0 keeps none.
 */
function collectableAge(graceSeconds: number): number {
	return graceSeconds === 0 ? 0 : graceSeconds + 1;
}

/**
 * A table whose rows reference snapshot blobs, with the triggers that index its future rows and the statements that
 * index the rows it already holds. Both are built from the same statements, so they cannot disagree.
 */
interface IndexSource {
	readonly name: string;
	readonly table: string;
	/** The triggers that index the table's future rows, in the order they are created. */
	readonly triggers: readonly StorageTrigger[];
	/** Each statement indexes the rows with `rowid > ? AND rowid <= ?`, bound in that order. */
	readonly backfill: readonly string[];
	/**
	 * When set, rows are indexed one at a time in rowid order, each statement bound to the row's rowid, instead of by
	 * `backfill`: a row's index depends on its parent's, which a statement over many rows cannot see.
	 */
	readonly rowwise?: readonly string[];
	/** Clears the source's index rows when its triggers are installed again, so no stale row outlives its entry. */
	readonly reset?: readonly string[];
}

interface SourceState {
	readonly source: IndexSource;
	readonly installed: boolean;
	readonly backfilled: boolean;
	readonly deferred: boolean;
}

const CHECKPOINT_EVENT = "CheckpointRecorded";
const STATUS_EVENTS = "'RunStarted', 'StatusChanged'";
const RELEASED_STATUSES = "'completed', 'cancelled'";
/** The `seq` of a run state taken from the run's header status, which any start or status event replaces. */
const HEADER_SEQ = -1;

type Column = (name: string) => string;
const newRow: Column = (name) => `NEW.${name}`;
const oldRow: Column = (name) => `OLD.${name}`;
const storedRow: Column = (name) => name;

/**
 * `test` on a payload that may not be JSON: SQLite does not promise to stop at the first false term of an AND, and
 * Postgres fails a cast of text that is not JSON.
 */
const whenValidJson = (d: StorageDialect, json: string, test: string) =>
	`CASE WHEN ${d.jsonValid(json)} THEN (${test}) ELSE ${d.literals.false} END`;

const triggerRows = (columns: readonly string[]) =>
	`(SELECT ${columns.map((name) => `NEW.${name} AS ${name}`).join(", ")})`;
const storedRows = (d: StorageDialect, table: string, columns: readonly string[], condition: string) =>
	`(SELECT ${columns.join(", ")} FROM ${table} WHERE ${d.rowOrder()} > ? AND ${d.rowOrder()} <= ? AND ${condition})`;

function checkpointCondition(d: StorageDialect, column: Column): string {
	const payload = column("payload");
	return `${column("type")} = '${CHECKPOINT_EVENT}' AND ${d.contains(payload, `'"worktreeSnapshots"'`)} AND ${whenValidJson(
		d,
		payload,
		`${d.jsonText(payload, "kind")} IN ('tool', 'stage')`,
	)}`;
}

function statusCondition(d: StorageDialect, column: Column): string {
	const payload = column("payload");
	return `${column("type")} IN (${STATUS_EVENTS}) AND ${whenValidJson(
		d,
		payload,
		`${d.jsonHasType("text", payload, "workflowId")} AND ${d.jsonHasType("text", payload, "status")} AND ${d.jsonType(payload, "completedCheckpoints")} IN ('integer', 'real') AND ${d.jsonType(payload, "pendingPrompts")} IN ('integer', 'real')`,
	)}`;
}

function snapshotEntryCondition(d: StorageDialect, column: Column): string {
	const entry = column("entry_json");
	return `${d.contains(entry, `'"worktree_snapshot"'`)} AND ${d.jsonText(entry, "type")} = 'worktree_snapshot' AND ${d.jsonHasType("text", entry, "root")} AND ${d.jsonHasType("text", entry, "snapshotId")}`;
}

/**
 * The SQL form of `isDurableWorkflowResumable` for the status payload `payload`, given that the run has a snapshot
 * reference and so at least one checkpoint: a root run keeps its snapshots while it is failed or blocked, or running or
 * paused, unless it was marked not resumable.
 */
function retainedByStatus(d: StorageDialect, payload: string): string {
	const root = d.jsonType(payload, "rootWorkflowId");
	return `CASE
		WHEN ${root} IS NOT NULL AND (${root} <> 'text' OR ${d.jsonText(payload, "rootWorkflowId")} <> ${d.jsonText(payload, "workflowId")}) THEN 0
		WHEN ${d.jsonText(payload, "status")} IN ('failed', 'blocked', 'running', 'paused') THEN ${d.flag(d.isDistinct(d.jsonType(payload, "resumable"), "'false'"))}
		ELSE 0
	END`;
}

/** A trigger of the reference index: after `event` on `table`, when `when` holds for the row, it runs `statements`. */
function createTrigger(
	name: string,
	event: string,
	table: string,
	statements: readonly string[],
	when?: string,
): StorageTrigger {
	const trigger = { name, table, timing: "AFTER", event, statements } as const;
	return when === undefined ? trigger : { ...trigger, when };
}

/** A table whose rows each carry the snapshot that dispatched work restores its tree from (#4503). */
interface CarriedSnapshots {
	readonly name: string;
	readonly table: string;
	/** The prefix of each row's owner in {@link SnapshotIndexTables.carriedRefs}, before the row's `key`. */
	readonly owner: "work" | "root";
	readonly key: string;
	/** The JSON column that holds the snapshot, at the object keys `path` (none: the whole document). */
	readonly json: string;
	readonly path: readonly string[];
	/** Text `json` holds whenever its row carries a snapshot, so a row that carries none costs the index nothing. */
	readonly marker?: string;
}

/**
 * Indexes the blobs of the snapshot each row of `carried.table` carries as the row's references, from its insert until
 * its delete; an update of the snapshot replaces them. A row whose JSON the database cannot parse references nothing,
 * so a write never fails on the index. No statement inserts a reference that exists already: an upsert's update runs
 * its triggers under its own conflict policy, which overrides their `OR IGNORE`.
 */
function carriedSource(d: StorageDialect, t: SnapshotIndexTables, carried: CarriedSnapshots): IndexSource {
	const { table, key, json, path, marker } = carried;
	const owner = (row: Column) => `'${carried.owner}:' || ${row(key)}`;
	const carries = (row: Column) => (marker === undefined ? undefined : d.contains(row(json), `'${marker}'`));
	const rowOf = (row: Column) =>
		`${owner(row)} AS owner, CASE WHEN ${d.jsonValid(row(json))} THEN ${row(json)} ELSE '{}' END AS snapshot`;
	const snapshot = { column: "r.snapshot" };
	const index = (rows: string) =>
		[
			{
				from: `, ${d.jsonEach(snapshot, "link", ...path, "chain")}`,
				link: { ...snapshot, element: "link" },
				keys: ["patch"],
			},
			{ from: "", link: snapshot, keys: [...path, "bundle", "blob"] },
		].map(({ from, link, keys }) => {
			const hash = d.jsonAt(link, ...keys);
			return d.insertOrIgnore(
				t.carriedRefs,
				["owner", "hash"],
				`SELECT DISTINCT r.owner, ${hash} FROM ${rows} AS r${from} WHERE ${d.jsonAtIsText(link, ...keys)} AND NOT EXISTS (SELECT 1 FROM ${t.carriedRefs} AS held WHERE held.owner = r.owner AND held.hash = ${hash})`,
			);
		});
	const inserted = `(SELECT ${rowOf(newRow)})`;
	const release = `DELETE FROM ${t.carriedRefs} WHERE owner = ${owner(oldRow)}`;
	const names = {
		insert: `${table}_snapshot_carried_insert`,
		update: `${table}_snapshot_carried_update`,
		delete: `${table}_snapshot_carried_delete`,
	};
	return {
		name: carried.name,
		table,
		triggers: [
			createTrigger(names.insert, "INSERT", table, index(inserted), carries(newRow)),
			createTrigger(
				names.update,
				`UPDATE OF ${json}`,
				table,
				[release, ...index(inserted)],
				marker === undefined ? undefined : `${carries(oldRow)} OR ${carries(newRow)}`,
			),
			createTrigger(names.delete, "DELETE", table, [release], carries(oldRow)),
		],
		backfill: index(storedRows(d, table, [rowOf(storedRow)], carries(storedRow) ?? d.literals.true)),
		reset: [`DELETE FROM ${t.carriedRefs} WHERE owner LIKE '${carried.owner}:%'`],
	};
}

function indexSources(prefix: string, t: SnapshotIndexTables, d: StorageDialect): readonly IndexSource[] {
	const { events, runs } = renderStorageIdentifiers("journal", { events: "events", runs: "runs" }, prefix);
	const { entries } = renderStorageIdentifiers("sessions", { entries: "entries" }, prefix);

	const payload = { column: "r.payload" };
	const snapshot = { ...payload, element: "snapshot" };
	const link = { ...payload, element: "link" };
	const snapshots = d.jsonEach(payload, "snapshot", "worktreeSnapshots");
	const runRefs = (rows: string) =>
		[
			{ from: `${snapshots}, ${d.jsonEach(snapshot, "link", "chain")}`, source: link, keys: ["patch"] },
			{ from: snapshots, source: snapshot, keys: ["bundle", "blob"] },
		].map(({ from, source, keys }) =>
			d.insertOrIgnore(
				t.runRefs,
				["run_id", "hash"],
				`SELECT r.run_id, ${d.jsonAt(source, ...keys)} FROM ${rows} AS r, ${from} WHERE ${d.jsonAtIsText(source, ...keys)}`,
			),
		);
	const released = (status: string) => d.flag(`${status} NOT IN (${RELEASED_STATUSES})`);
	const runState = (rows: string) =>
		`INSERT INTO ${t.runState} (run_id, retained, seq) SELECT r.run_id, ${retainedByStatus(d, "r.payload")}, r.seq FROM ${rows} AS r WHERE true ON CONFLICT (run_id) DO UPDATE SET retained = excluded.retained, seq = excluded.seq WHERE excluded.seq >= ${t.runState}.seq`;
	const runHeader = (rows: string) =>
		`INSERT INTO ${t.runState} (run_id, retained, seq) SELECT r.run_id, ${released("r.status")}, ${HEADER_SEQ} FROM ${rows} AS r WHERE true ON CONFLICT (run_id) DO NOTHING`;
	const entryRow = (name: string) => `r.${name}`;
	const entry = { column: "r.entry_json" };
	const parentType = "r.parent_type";
	const parentId = "r.parent_id";
	const isSnapshot = snapshotEntryCondition(d, entryRow);
	const parentOf = (rows: string) =>
		`${rows} AS r LEFT JOIN ${t.sessionLinks} AS parent ON parent.session_id = r.session_id AND parent.entry_id = ${parentId} AND ${parentType} = 'text'`;
	/**
	 * Indexes one session entry's link in the session tree. `rows` yields that one entry as `r`; its parent was indexed
	 * before it.
	 */
	const sessionLink = (rows: string) => [
		`UPDATE ${t.sessionLinks} SET children = children + 1 FROM ${rows} AS r WHERE ${t.sessionLinks}.session_id = r.session_id AND ${t.sessionLinks}.entry_id = ${parentId} AND ${parentType} = 'text' AND NOT EXISTS (SELECT 1 FROM ${t.sessionLinks} AS own WHERE own.session_id = r.session_id AND own.seq = r.seq)`,
		d.insertOrIgnore(
			t.sessionLinks,
			["session_id", "seq", "entry_id", "parent_id", "anchor_seq", "children", "broken"],
			`SELECT r.session_id, r.seq, r.entry_id, CASE WHEN ${parentType} = 'text' THEN ${parentId} END, CASE WHEN ${isSnapshot} THEN r.seq ELSE parent.anchor_seq END, 0, CASE WHEN EXISTS (SELECT 1 FROM ${t.sessionLinks} AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND other.seq <> r.seq) THEN 1 WHEN ${parentType} IS NULL OR ${parentType} = 'null' THEN 0 WHEN ${parentType} = 'text' AND parent.entry_id IS NOT NULL THEN parent.broken ELSE 1 END FROM ${parentOf(rows)}`,
		),
	];
	/** Indexes a snapshot entry's reference and the blobs of its record; any other entry adds nothing. */
	const sessionRecord = (rows: string) => {
		const record = (source: StorageJsonSource, keys: readonly string[], from = "") =>
			d.insertOrIgnore(
				t.sessionRecords,
				["session_id", "seq", "snapshot_id", "hash"],
				`SELECT r.session_id, r.seq, ${d.jsonText(entry.column, "snapshotId")}, ${d.jsonAt(source, ...keys)} FROM ${rows} AS r${from} WHERE ${d.jsonAtIsText(source, ...keys)} AND ${isSnapshot}`,
			);
		const restored = `${d.jsonHasType("text", entry.column, "restore", "from")} AND ${d.jsonHasType("text", entry.column, "restore", "to")}`;
		const pinned = d.jsonHasType("text", entry.column, "degradedFrom");
		const degradedFrom = d.jsonText(entry.column, "degradedFrom");
		// A pin began with the first entry naming its snapshot; entries that go on naming it keep that start (#4922).
		const degradedSince = `COALESCE((SELECT earlier.degraded_since FROM ${t.sessionRefs} AS earlier WHERE earlier.session_id = r.session_id AND earlier.seq = parent.anchor_seq AND earlier.degraded_from = ${degradedFrom}), ${d.nowSeconds})`;
		return [
			d.insertOrReplace(
				t.sessionRefs,
				[
					"session_id",
					"seq",
					"root",
					"snapshot_id",
					"prev_seq",
					"restore_from",
					"restore_to",
					"degraded_from",
					"degraded_since",
				],
				["session_id", "seq"],
				`SELECT r.session_id, r.seq, ${d.jsonText(entry.column, "root")}, ${d.jsonText(entry.column, "snapshotId")}, parent.anchor_seq, CASE WHEN ${restored} THEN ${d.jsonText(entry.column, "restore", "from")} END, CASE WHEN ${restored} THEN ${d.jsonText(entry.column, "restore", "to")} END, CASE WHEN ${pinned} THEN ${degradedFrom} END, CASE WHEN ${pinned} THEN ${degradedSince} END FROM ${parentOf(rows)} WHERE ${isSnapshot}`,
			),
			record({ ...entry, element: "link" }, ["patch"], `, ${d.jsonEach(entry, "link", "snapshot", "chain")}`),
			record(entry, ["snapshot", "bundle", "blob"]),
		];
	};

	const eventColumns = ["run_id", "seq", "payload"];
	const eventsSource = {
		name: "journal-events",
		table: events,
		triggers: [
			createTrigger(
				`${events}_snapshot_refs`,
				"INSERT",
				events,
				runRefs(triggerRows(eventColumns)),
				checkpointCondition(d, newRow),
			),
			createTrigger(
				`${events}_snapshot_state`,
				"INSERT",
				events,
				[runState(triggerRows(eventColumns))],
				statusCondition(d, newRow),
			),
		],
		backfill: [
			...runRefs(storedRows(d, events, eventColumns, checkpointCondition(d, storedRow))),
			runState(storedRows(d, events, eventColumns, statusCondition(d, storedRow))),
		],
	};
	const headerColumns = ["run_id", "status"];
	const runsSource = {
		name: "journal-runs",
		table: runs,
		triggers: [
			createTrigger(`${runs}_snapshot_state_insert`, "INSERT", runs, [runHeader(triggerRows(headerColumns))]),
			createTrigger(`${runs}_snapshot_state_status`, "UPDATE OF status", runs, [
				`UPDATE ${t.runState} SET retained = ${released("NEW.status")} WHERE run_id = NEW.run_id AND seq = ${HEADER_SEQ}`,
			]),
			createTrigger(`${runs}_snapshot_refs_delete`, "DELETE", runs, [
				`DELETE FROM ${t.runRefs} WHERE run_id = OLD.run_id`,
				`DELETE FROM ${t.runState} WHERE run_id = OLD.run_id`,
			]),
		],
		backfill: [runHeader(storedRows(d, runs, headerColumns, d.literals.true))],
	};
	const entryColumns = ["session_id", "seq", "entry_id", "entry_json"];
	/** One entry as `r`, with its parent named once, so that each statement parses the entry's JSON for it only once. */
	const parentColumns = (json: string) =>
		`${d.jsonText(json, "parentId")} AS parent_id, ${d.jsonType(json, "parentId")} AS parent_type`;
	const triggerEntry = `(SELECT ${entryColumns.map((name) => `NEW.${name} AS ${name}`).join(", ")}, ${parentColumns("NEW.entry_json")})`;
	const storedEntry = `(SELECT ${entryColumns.join(", ")}, ${parentColumns("entry_json")} FROM ${entries} WHERE ${d.rowOrder()} = ?)`;
	const indexComplete = `(SELECT backfilled_through >= watermark FROM ${t.sources} WHERE source = 'session-entries')`;
	const newRowOrder = d.rowOrder("NEW");
	const entriesSource = {
		name: "session-entries",
		table: entries,
		triggers: [
			// While the rows that existed first are indexed, new rows wait for that pass, which keeps parents ahead of
			// their children: the pass reaches them by extending its watermark. A row written at a rowid the pass has
			// already gone by, which SQLite reuses once the newest rows are deleted, moves the pass back to it; indexing
			// a row twice changes nothing.
			createTrigger(`${entries}_snapshot_links`, "INSERT", entries, sessionLink(triggerEntry), indexComplete),
			createTrigger(
				`${entries}_snapshot_refs`,
				"INSERT",
				entries,
				sessionRecord(triggerEntry),
				`${d.contains("NEW.entry_json", `'"worktree_snapshot"'`)} AND ${indexComplete}`,
			),
			createTrigger(
				`${entries}_snapshot_pending`,
				"INSERT",
				entries,
				[
					`UPDATE ${t.sources} SET watermark = ${newRowOrder} WHERE source = 'session-entries' AND watermark < ${newRowOrder}`,
					`UPDATE ${t.sources} SET backfilled_through = ${newRowOrder} - 1 WHERE source = 'session-entries' AND backfilled_through >= ${newRowOrder}`,
				],
				`NOT COALESCE(${indexComplete}, ${d.literals.true})`,
			),
			createTrigger(`${entries}_snapshot_refs_delete`, "DELETE", entries, [
				`UPDATE ${t.sessionLinks} SET children = children - 1 WHERE session_id = OLD.session_id AND children > 0 AND entry_id = (SELECT parent_id FROM ${t.sessionLinks} WHERE session_id = OLD.session_id AND seq = OLD.seq)`,
				`DELETE FROM ${t.sessionLinks} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
				`DELETE FROM ${t.sessionRefs} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
				`DELETE FROM ${t.sessionRecords} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
			]),
		],
		backfill: [],
		rowwise: [...sessionLink(storedEntry), ...sessionRecord(storedEntry)],
		reset: [`DELETE FROM ${t.sessionLinks}`, `DELETE FROM ${t.sessionRefs}`, `DELETE FROM ${t.sessionRecords}`],
	};
	// What a shared-placement root carries to its children (#4503): the snapshot each queued pool work row carries, and
	// the one of the root's own binding, which its pool records while it is prepared, children queued or not.
	const workSource = carriedSource(d, t, {
		name: "journal-pool-work",
		table: `${runs}_work`,
		owner: "work",
		key: "id",
		json: "descriptor",
		path: ["execution", "workspaceSnapshot"],
		marker: '"workspaceSnapshot"',
	});
	const rootSource = carriedSource(d, t, {
		name: "journal-pool-root-snapshot",
		table: `${runs}_pool_root_snapshot`,
		owner: "root",
		key: "root",
		json: "snapshot",
		path: [],
	});
	return [eventsSource, runsSource, entriesSource, workSource, rootSource];
}

/**
 * Chunked blobs (#4954): the chunk table, the blob table's `chunks` column, 0 for a blob whose bytes are in its own row,
 * as every blob written before it was, and the trigger that deletes a blob's chunks with it. Idempotent.
 */
async function addBlobChunks(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	dialect: StorageDialect,
): Promise<void> {
	const { int, text, blob } = dialect.types;
	await transaction.exec(
		`CREATE TABLE IF NOT EXISTS ${t.blobChunks} (hash ${text} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL, PRIMARY KEY (hash, idx))${dialect.withoutRowidTableOptions}`,
	);
	const column = dialect.columnExists(t.blobs, "chunks");
	if (!(await transaction.get(column.sql, ...column.params))) {
		await transaction.exec(`ALTER TABLE ${t.blobs} ADD COLUMN chunks ${int} NOT NULL DEFAULT 0`);
	}
	// A deleted blob takes its chunks with it, in the statement that deletes it, whoever deletes it.
	const trigger = dialect.schemaObjects([`${t.blobs}_chunks_delete`]);
	if (await transaction.get(trigger.sql, ...trigger.params)) return;
	await transaction.exec(
		dialect.renderTrigger(
			createTrigger(
				`${t.blobs}_chunks_delete`,
				"DELETE",
				t.blobs,
				[`DELETE FROM ${t.blobChunks} WHERE hash = OLD.hash`],
				"OLD.chunks > 0",
			),
		),
	);
}

/** Creates the blob table and the tables of its reference index that are missing. */
async function createSnapshotIndexTables(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
): Promise<void> {
	const { int, text, blob } = dialect.types;
	const strict = dialect.tableOptions;
	const keyed = dialect.withoutRowidTableOptions;
	await transaction.exec(
		`CREATE TABLE IF NOT EXISTS ${t.blobs} (hash ${text} PRIMARY KEY, bytes ${int} NOT NULL, data ${blob} NOT NULL, created_at ${int} NOT NULL DEFAULT (${dialect.nowSeconds}))${strict}`,
	);
	const ageColumn = dialect.columnExists(t.blobs, "created_at");
	const age = await transaction.get<SqliteRow & { default_value: SqliteValue }>(ageColumn.sql, ...ageColumn.params);
	if (!age) {
		// Unknown ages are stamped in short collection batches, never by rewriting the table at open.
		await transaction.exec(`ALTER TABLE ${t.blobs} ADD COLUMN created_at ${int} NOT NULL DEFAULT 0`);
	}
	// A constant zero default identifies an upgraded table. Its age index is also deferred to collection.
	if (age && String(age.default_value) !== "0") {
		await transaction.exec(`CREATE INDEX IF NOT EXISTS ${t.blobs}_age ON ${t.blobs} (created_at, hash)`);
	}
	await transaction.exec(`
		CREATE TABLE IF NOT EXISTS ${t.runRefs} (run_id ${text} NOT NULL, hash ${text} NOT NULL, PRIMARY KEY (run_id, hash))${keyed};
		CREATE INDEX IF NOT EXISTS ${t.runRefs}_hash ON ${t.runRefs} (hash);
		CREATE TABLE IF NOT EXISTS ${t.runState} (run_id ${text} PRIMARY KEY, retained ${int} NOT NULL, seq ${int} NOT NULL)${keyed};
		CREATE TABLE IF NOT EXISTS ${t.sessionRefs} (session_id ${text} NOT NULL, seq ${int} NOT NULL, root ${text} NOT NULL, snapshot_id ${text} NOT NULL, prev_seq ${int}, restore_from ${text}, restore_to ${text}, degraded_from ${text}, degraded_since ${int}, PRIMARY KEY (session_id, seq))${keyed};
		CREATE TABLE IF NOT EXISTS ${t.sessionLinks} (session_id ${text} NOT NULL, seq ${int} NOT NULL, entry_id ${text} NOT NULL, parent_id ${text}, anchor_seq ${int}, children ${int} NOT NULL, broken ${int} NOT NULL, PRIMARY KEY (session_id, seq))${strict};
		CREATE INDEX IF NOT EXISTS ${t.sessionLinks}_entry ON ${t.sessionLinks} (session_id, entry_id);
		CREATE INDEX IF NOT EXISTS ${t.sessionLinks}_leaves ON ${t.sessionLinks} (session_id, anchor_seq) WHERE children = 0 AND anchor_seq IS NOT NULL;
		CREATE INDEX IF NOT EXISTS ${t.sessionLinks}_broken ON ${t.sessionLinks} (session_id) WHERE broken = 1;
		CREATE TABLE IF NOT EXISTS ${t.sessionRecords} (session_id ${text} NOT NULL, seq ${int} NOT NULL, snapshot_id ${text} NOT NULL, hash ${text} NOT NULL, PRIMARY KEY (session_id, seq, hash))${keyed};
		CREATE INDEX IF NOT EXISTS ${t.sessionRecords}_hash ON ${t.sessionRecords} (hash);
		CREATE TABLE IF NOT EXISTS ${t.carriedRefs} (owner ${text} NOT NULL, hash ${text} NOT NULL, PRIMARY KEY (owner, hash))${keyed};
		CREATE INDEX IF NOT EXISTS ${t.carriedRefs}_hash ON ${t.carriedRefs} (hash);
		CREATE TABLE IF NOT EXISTS ${t.collection} (id ${int} PRIMARY KEY CHECK (id = 1), claimed_at ${int}, holder ${text}, finished_at ${int}, deleted ${int}, error_code ${text})${strict};
		INSERT INTO ${t.collection} (id) VALUES (1) ON CONFLICT DO NOTHING;
		CREATE TABLE IF NOT EXISTS ${t.sources} (source ${text} PRIMARY KEY, watermark ${int} NOT NULL, backfilled_through ${int} NOT NULL)${keyed};
	`);
	await addBlobChunks(transaction, t, dialect);
	await addSessionRefColumns(transaction, t, prefix, dialect);
}

/** The columns of {@link SnapshotIndexTables.sessionRefs} that later builds added, with their types. */
const SESSION_REF_COLUMNS = ["prev_seq", "restore_from", "restore_to", "degraded_from", "degraded_since"] as const;

/**
 * Adds the columns of the session references that an index written by an earlier build lacks. Adding any drops the
 * session entries' triggers and marks their index for a rebuild, which collection runs before it deletes anything.
 */
async function addSessionRefColumns(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
): Promise<void> {
	const { int, text } = dialect.types;
	const types: Record<(typeof SESSION_REF_COLUMNS)[number], string> = {
		prev_seq: int,
		restore_from: text,
		restore_to: text,
		degraded_from: text,
		degraded_since: int,
	};
	let migrated = false;
	for (const name of SESSION_REF_COLUMNS) {
		const type = types[name];
		const column = dialect.columnExists(t.sessionRefs, name);
		if (await transaction.get(column.sql, ...column.params)) continue;
		await transaction.exec(`ALTER TABLE ${t.sessionRefs} ADD COLUMN ${name} ${type}`);
		migrated = true;
	}
	if (migrated) {
		// Mark the tree-aware rebuild durably, but leave its old rows untouched until completeIndex runs.
		const source = indexSources(prefix, t, dialect).find((source) => source.name === "session-entries")!;
		for (const trigger of source.triggers) await transaction.exec(dialect.dropTrigger(trigger.name, trigger.table));
		await transaction.run(
			`INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, -1, -1) ${REPLACE_PROGRESS}`,
			source.name,
		);
	}
}

/** Replaces a source's progress row: `sources` has no triggers or references, so this upsert is what a REPLACE did. */
const REPLACE_PROGRESS =
	"ON CONFLICT (source) DO UPDATE SET watermark = excluded.watermark, backfilled_through = excluded.backfilled_through";

/** Installs `source`'s index triggers and records that rows above its current last row are indexed by them. */
async function installSource(
	transaction: SqliteExecutor,
	dialect: StorageDialect,
	t: SnapshotIndexTables,
	source: IndexSource,
): Promise<void> {
	for (const sql of source.reset ?? []) await transaction.run(sql);
	await transaction.exec(source.triggers.map((trigger) => dialect.renderTrigger(trigger)).join("\n"));
	await transaction.run(
		`INSERT INTO ${t.sources} (source, watermark, backfilled_through) SELECT ?, COALESCE(MAX(${dialect.rowOrder()}), 0), 0 FROM ${source.table} WHERE true ${REPLACE_PROGRESS}`,
		source.name,
	);
}

/**
 * Installs the index triggers of every referencing table that exists and lacks them, except a source whose rebuild is
 * deferred to collection. Installing again replaces nothing, so the step can run any number of times.
 */
async function installMissingSources(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
): Promise<void> {
	for (const { source, installed, deferred } of await readSourceStates(
		transaction,
		dialect,
		t,
		indexSources(prefix, t, dialect),
	)) {
		if (!installed && !deferred) await installSource(transaction, dialect, t, source);
	}
}

/** Which referencing tables exist, whether each has all its triggers and a source row, and whether its backfill is done. */
async function readSourceStates(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	t: SnapshotIndexTables,
	sources: readonly IndexSource[],
): Promise<SourceState[]> {
	const names = sources.flatMap((source) => [source.table, ...source.triggers.map((trigger) => trigger.name)]);
	const objects = dialect.schemaObjects(names);
	const present = new Set(
		(await executor.all<SqliteRow & { name: string }>(objects.sql, ...objects.params)).map((row) => row.name),
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
				installed:
					row !== undefined &&
					Number(row.watermark) >= 0 &&
					source.triggers.every((trigger) => present.has(trigger.name)),
				backfilled:
					row !== undefined &&
					Number(row.watermark) >= 0 &&
					Number(row.backfilled_through) >= Number(row.watermark),
				deferred: row !== undefined && Number(row.watermark) === -1,
			};
		});
}

/** The `<prefix>snapshot_blobs` table and its reference index, shared by the session store and run journal of one database. */
export class SqlSnapshotBlobStore implements SnapshotBlobStore {
	private readonly database: SqliteDatabase;
	private readonly tables: SnapshotIndexTables;
	private readonly sources: readonly IndexSource[];
	private readonly dialect: StorageDialect;
	readonly table: string;

	private constructor(
		database: SqliteDatabase,
		dialect: StorageDialect,
		tables: SnapshotIndexTables,
		sources: readonly IndexSource[],
	) {
		this.database = database;
		this.dialect = dialect;
		this.tables = tables;
		this.sources = sources;
		this.table = tables.blobs;
	}

	/** Which table this store collects, for telling stores of one database and prefix apart from others. */
	get identity(): string {
		return `${databaseIdentity(this.database.descriptor)}${this.table}`;
	}

	/**
	 * Opens the blob table and its reference index, creating the tables that are missing in their own transaction, such
	 * as those an index written by an earlier build lacks, and indexes referencing tables created since. A store whose
	 * tables and index exist opens without the write lock.
	 */
	static async open(database: SqliteDatabase, prefix = ""): Promise<SqlSnapshotBlobStore> {
		const t = snapshotIndexTables(prefix);
		const dialect = dialectOf(database);
		const probes = [
			...Object.values(t).map((table) => dialect.tableExists(table)),
			dialect.columnExists(t.blobs, "created_at"),
			dialect.columnExists(t.blobs, "chunks"),
			dialect.schemaObjects([`${t.blobs}_chunks_delete`]),
			...SESSION_REF_COLUMNS.map((column) => dialect.columnExists(t.sessionRefs, column)),
		];
		const found = await Promise.all(probes.map((probe) => database.get(probe.sql, ...probe.params)));
		// A versioned database always checks its ledger: a newer schema with the same tables is refused, and a step it
		// lacks, such as the index triggers, runs even when every table exists.
		if (dialect.versionedMigrations || !found.every((row) => row !== undefined)) {
			await applyStorageMigrations(
				database,
				SNAPSHOT_BLOB_DOMAIN,
				[
					{ version: 1, up: (transaction, dialect) => createSnapshotIndexTables(transaction, t, prefix, dialect) },
					// Where a ledger records the steps, it records the index triggers too, installed under the migration lock.
					// Without one, installIndex below installs each source in a transaction of its own, as it always has.
					...(dialect.versionedMigrations
						? [
								{
									version: 2,
									up: (transaction: SqliteExecutor, dialect: StorageDialect) =>
										installMissingSources(transaction, t, prefix, dialect),
								},
								// The pins of partly restored worktrees (#4922); SQLite adds them in step 1, which runs every time.
								{
									version: 3,
									up: (transaction: SqliteExecutor, dialect: StorageDialect) =>
										addSessionRefColumns(transaction, t, prefix, dialect),
								},
								// Chunked blobs (#4954); SQLite adds them in step 1, which runs every time.
								{
									version: 4,
									up: (transaction: SqliteExecutor, dialect: StorageDialect) =>
										addBlobChunks(transaction, t, dialect),
								},
							]
						: []),
				],
				{ table: storageMigrationTable(prefix) },
			);
		}
		const store = new SqlSnapshotBlobStore(database, dialect, t, indexSources(prefix, t, dialect));
		await store.installIndex();
		return store;
	}

	/**
	 * Creates the blob table and its reference index inside the caller's transaction, and indexes the referencing tables
	 * that exist, so a store that creates its own tables, such as a new run journal, takes the write lock once for all
	 * of them.
	 */
	static async initialize(transaction: SqliteExecutor, prefix = "", dialect: StorageDialect): Promise<void> {
		const t = snapshotIndexTables(prefix);
		await createSnapshotIndexTables(transaction, t, prefix, dialect);
		await installMissingSources(transaction, t, prefix, dialect);
	}

	/**
	 * Stores every blob, in one transaction, or restarts the age of one stored already. A blob larger than
	 * {@link SNAPSHOT_BLOB_CHUNK_BYTES} is stored as chunk rows and a header row that names how many, so no statement
	 * binds more than one chunk (#4954); the chunks of a blob stored already are not written again.
	 */
	async putBlobs(blobs: readonly SnapshotBlob[]): Promise<void> {
		if (blobs.length === 0) return;
		const now = this.dialect.nowSeconds;
		const header = `INSERT INTO ${this.table} (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, ${now}, ?) ON CONFLICT(hash) DO UPDATE SET created_at = ${now}`;
		const chunk = `INSERT INTO ${this.tables.blobChunks} (hash, idx, data) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${this.table} WHERE hash = ?) ON CONFLICT DO NOTHING`;
		const statements: { sql: string; params: SqliteValue[] }[] = [];
		for (const blob of blobs) {
			const { hash, data } = blob;
			if (data.byteLength <= SNAPSHOT_BLOB_CHUNK_BYTES) {
				statements.push({ sql: header, params: [hash, data.byteLength, data, 0] });
				continue;
			}
			const chunks = Math.ceil(data.byteLength / SNAPSHOT_BLOB_CHUNK_BYTES);
			for (let index = 0; index < chunks; index++) {
				const bytes = data.subarray(index * SNAPSHOT_BLOB_CHUNK_BYTES, (index + 1) * SNAPSHOT_BLOB_CHUNK_BYTES);
				statements.push({ sql: chunk, params: [hash, index, bytes, hash] });
			}
			statements.push({ sql: header, params: [hash, data.byteLength, new Uint8Array(), chunks] });
		}
		if (this.database.batch) {
			await this.database.batch(statements);
			return;
		}
		await this.database.transaction(async (transaction) => {
			for (const statement of statements) await transaction.run(statement.sql, ...statement.params);
		});
	}
	/**
	 * The blob's bytes, read a chunk per statement when it has chunks, so no response holds more than one chunk. A
	 * chunked blob whose chunks are not all there, as when a collection deleted it during the read, is not returned.
	 */
	async getBlob(hash: string): Promise<Uint8Array | undefined> {
		const row = await this.database.get<SqliteRow & { data: Uint8Array; bytes: number; chunks: number }>(
			`SELECT data, bytes, chunks FROM ${this.table} WHERE hash = ?`,
			hash,
		);
		if (row === undefined) return undefined;
		const chunks = Number(row.chunks);
		if (chunks === 0) return row.data;
		const data = new Uint8Array(Number(row.bytes));
		let offset = 0;
		for (let index = 0; index < chunks; index++) {
			const chunk = await this.database.get<SqliteRow & { data: Uint8Array }>(
				`SELECT data FROM ${this.tables.blobChunks} WHERE hash = ? AND idx = ?`,
				hash,
				index,
			);
			if (chunk === undefined || offset + chunk.data.byteLength > data.byteLength) return undefined;
			data.set(chunk.data, offset);
			offset += chunk.data.byteLength;
		}
		return offset === data.byteLength ? data : undefined;
	}
	/** Restarts the age of every stored hash in one statement on the database clock; false when any is missing. */
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		const unique = [...new Set(hashes)];
		if (unique.length === 0) return true;
		// One request where the database takes batches: a server holds its write lock for that request only (#4768).
		if (this.database.batch) {
			const [refreshed] = await this.database.batch([
				{
					sql: `UPDATE ${this.table} SET created_at = unixepoch() WHERE hash IN (SELECT value FROM json_each(?)) RETURNING hash`,
					params: [JSON.stringify(unique)],
				},
			]);
			return refreshed!.length === unique.length;
		}
		const { changes } = await this.database.transaction((transaction) =>
			transaction.run(
				`UPDATE ${this.table} SET created_at = ${this.dialect.nowSeconds} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")})`,
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
	 * Rejects with a `blobs-collected` {@link WorkspaceSnapshotError} naming the first of `snapshots`' blobs this table
	 * does not hold in full, a chunked blob's chunks included (#5077). Run in the write transaction that records the
	 * snapshots, it keeps a collection that ran after their capture stored the blobs from leaving a recorded snapshot
	 * that cannot be restored: the blobs it finds stay until that transaction ends, and the references it writes keep
	 * them after.
	 */
	async assertStored(transaction: SqliteExecutor, snapshots: readonly WorktreeSnapshot[]): Promise<void> {
		const hashes = [...new Set(snapshots.flatMap(snapshotBlobHashes))];
		if (hashes.length === 0) return;
		const rows = await transaction.all<SqliteRow & { hash: string }>(
			`SELECT hash FROM ${this.table} AS b WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND (chunks = 0 OR chunks = (SELECT COUNT(*) FROM ${this.tables.blobChunks} AS c WHERE c.hash = b.hash))${this.dialect.lockClause("share")}`,
			JSON.stringify(hashes),
		);
		const stored = new Set(rows.map((row) => row.hash));
		const missing = hashes.find((hash) => !stored.has(hash));
		if (missing !== undefined) throw new WorkspaceSnapshotError("blobs-collected", missing);
	}

	/**
	 * Installs the index triggers of every referencing table that lacks them, each with a watermark, the highest rowid
	 * the table holds in the same transaction, so every row is either at or below the watermark, to be backfilled, or
	 * above it, indexed by the triggers. A table that has none yet, an empty one included, costs one watermark of 0.
	 * Resolves with the state of every referencing table.
	 */
	private async installIndex(pace?: BackgroundCollectionPace, includeDeferred = false): Promise<SourceState[]> {
		const states = await readSourceStates(this.database, this.dialect, this.tables, this.sources);
		const missing = states.filter((state) => !state.installed && (includeDeferred || !state.deferred));
		for (const { source } of missing) {
			await this.write(pace, async (transaction) => {
				const [current] = await readSourceStates(transaction, this.dialect, this.tables, [source]);
				if (current === undefined || current.installed || (current.deferred && !includeDeferred)) return;
				await installSource(transaction, this.dialect, this.tables, source);
			});
		}
		return missing.length === 0 ? states : readSourceStates(this.database, this.dialect, this.tables, this.sources);
	}

	/**
	 * Indexes the rows that referencing tables held before their triggers were installed, in transactions of
	 * {@link SNAPSHOT_INDEX_BACKFILL_BATCH} rows, so that the index covers every reference. A one-time cost in the number
	 * of existing rows, paid in the background by the first collection; resumes where it stopped. Does nothing once the
	 * index is complete. Yields to the event loop between batches, and checks `signal` before each batch and rejects
	 * with its reason.
	 */
	async completeIndex(options: SnapshotIndexOptions = {}): Promise<void> {
		for (const { source, backfilled } of await this.installIndex(options.pace, true)) {
			if (backfilled) continue;
			for (;;) {
				options.signal?.throwIfAborted();
				if (await this.backfillBatch(source, options)) break;
				await this.betweenBatches(options.pace);
			}
		}
	}

	/** Indexes the next rows of `source`, and resolves true once every row at or below its watermark is indexed. */
	private backfillBatch(source: IndexSource, { holder, pace, signal }: SnapshotIndexOptions): Promise<boolean> {
		const t = this.tables;
		const row = this.dialect.rowOrder();
		return this.write(pace, async (transaction) => {
			const progress = await transaction.get<SqliteRow & { watermark: number; backfilled_through: number }>(
				`SELECT watermark, backfilled_through FROM ${t.sources} WHERE source = ?`,
				source.name,
			);
			if (progress === undefined || progress.backfilled_through >= progress.watermark) return true;
			const { upper: lastRow } = (await transaction.get<SqliteRow & { upper: number | null }>(
				`SELECT MAX(${row}) AS upper FROM (SELECT ${row} FROM ${source.table} WHERE ${row} > ? AND ${row} <= ? ORDER BY ${row} LIMIT ?)`,
				progress.backfilled_through,
				progress.watermark,
				SNAPSHOT_INDEX_BACKFILL_BATCH,
			))!;
			const upper = lastRow ?? progress.watermark;
			for (const sql of source.backfill) await transaction.run(sql, progress.backfilled_through, upper);
			if (source.rowwise !== undefined) {
				const rows = await transaction.all<SqliteRow & { id: number }>(
					`SELECT ${row} AS id FROM ${source.table} WHERE ${row} > ? AND ${row} <= ? ORDER BY ${row}`,
					progress.backfilled_through,
					upper,
				);
				for (const { id } of rows) {
					// Stopping between rows rolls the whole batch back, progress included, so the pass stays resumable.
					signal?.throwIfAborted();
					for (const sql of source.rowwise) await transaction.run(sql, id);
				}
			}
			await transaction.run(`UPDATE ${t.sources} SET backfilled_through = ? WHERE source = ?`, upper, source.name);
			if (holder !== undefined) await this.renewClaim(transaction, holder);
			return upper >= progress.watermark;
		});
	}

	/**
	 * Deletes every blob stored or re-stored at least `graceSeconds` ago on the database clock that no retained snapshot
	 * and no snapshot dispatched work carries references, in batches of {@link SNAPSHOT_COLLECTION_BATCH}, and resolves
	 * with the hashes deleted. Each batch is one write transaction whose delete re-checks age and references in the same
	 * statement, so a reference published before the batch commits keeps its blob and a process killed mid-collection
	 * leaves only garbage. Each batch's page holds only blobs it can delete, so a sweep started again after a process
	 * exited makes progress even when the oldest blobs are all retained. Reads the reference index and the blob table's
	 * age index, never a journal or a session. Ages are counted in whole seconds, so a blob can stay up to a second past
	 * `graceSeconds`, never less.
	 *
	 * Every batch first checks, in its own transaction, that every referencing table has its triggers and a finished
	 * backfill, as {@link completeIndex} leaves them. When one does not, because a table appeared or lost its triggers
	 * since, nothing is deleted until the index has been completed again. A sweep repairs the index once; when it is
	 * incomplete again after that, because the schema keeps changing under it, the sweep stops without deleting
	 * anything more and the next collection tries again. Yields to the event loop between batches, and checks `signal`
	 * before each batch and rejects with its reason.
	 */
	async sweep(options: SnapshotSweepOptions): Promise<readonly string[]> {
		const t = this.tables;
		options.signal?.throwIfAborted();
		const ageIndex = this.dialect.schemaObjects([`${t.blobs}_age`]);
		if (!(await this.database.get(ageIndex.sql, ...ageIndex.params))) {
			await this.write(options.pace, (tx) =>
				tx.exec(`CREATE INDEX IF NOT EXISTS ${t.blobs}_age ON ${t.blobs} (created_at, hash)`),
			);
		}
		const unreferenced = `NOT EXISTS (
				SELECT 1 FROM ${t.runRefs} AS ref WHERE ref.hash = ${t.blobs}.hash
				AND NOT EXISTS (SELECT 1 FROM ${t.runState} AS state WHERE state.run_id = ref.run_id AND state.retained = 0)
			) AND NOT EXISTS (
				SELECT 1 FROM ${t.sessionRecords} AS record
				WHERE record.hash = ${t.blobs}.hash AND (
					(record.session_id, record.snapshot_id) IN (${this.sessionHeads()})
					OR EXISTS (SELECT 1 FROM ${t.sessionLinks} AS broken WHERE broken.session_id = record.session_id AND broken.broken = 1)
				)
			) AND NOT EXISTS (SELECT 1 FROM ${t.carriedRefs} AS carried WHERE carried.hash = ${t.blobs}.hash)`;
		const minimumAge = collectableAge(options.graceSeconds);
		const deleted: string[] = [];
		let cursor: PageRow | undefined;
		let repaired = false;
		for (;;) {
			options.signal?.throwIfAborted();
			const after = cursor;
			const batch = await this.write(options.pace, async (transaction) => {
				const states = await readSourceStates(transaction, this.dialect, this.tables, this.sources);
				if (!states.every((state) => state.installed && state.backfilled)) return undefined;
				if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
				const page = await this.page(transaction, minimumAge, unreferenced, after);
				if (page.length === 0) return { page, deleted: [] };
				const rows = await transaction.all<SqliteRow & { hash: string }>(
					`DELETE FROM ${t.blobs} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND created_at > 0 AND created_at <= ${this.dialect.nowSeconds} - ? AND ${unreferenced} RETURNING hash`,
					JSON.stringify(page.map((row) => row.hash)),
					minimumAge,
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
			if (batch.page.length < SNAPSHOT_COLLECTION_BATCH) {
				// Stamp unknown ages after deletion finishes, so even graceSeconds: 0 never deletes a row just stamped.
				await this.stampLegacyAges(options);
				return deleted;
			}
			cursor = batch.page.at(-1);
			await this.betweenBatches(options.pace);
		}
	}

	private async stampLegacyAges(options: SnapshotIndexOptions): Promise<void> {
		if (!(await this.database.get(`SELECT 1 FROM ${this.table} WHERE created_at = 0 LIMIT 1`))) return;
		for (;;) {
			options.signal?.throwIfAborted();
			const stamped = await this.write(options.pace, async (transaction) => {
				if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
				const { changes } = await transaction.run(
					`UPDATE ${this.table} SET created_at = ${this.dialect.nowSeconds} WHERE hash IN
					(SELECT hash FROM ${this.table} WHERE created_at = 0 ORDER BY hash LIMIT ?) AND created_at = 0`,
					SNAPSHOT_COLLECTION_BATCH,
				);
				return changes;
			});
			if (stamped < SNAPSHOT_COLLECTION_BATCH) return;
			await this.betweenBatches(options.pace);
		}
	}

	/** {@link completeIndex}, then {@link sweep}: what a manual collection does. */
	async collectGarbage(options: SnapshotSweepOptions): Promise<readonly string[]> {
		await this.completeIndex(options);
		return this.sweep(options);
	}

	/**
	 * The snapshots sessions keep, as a subquery of `(session_id, snapshot_id)`: for every leaf of every session tree,
	 * the latest snapshot entry of each checkout on the leaf's branch, followed through each entry's link to the
	 * nearest snapshot entry before it. A leaf costs the snapshot entries on its branch and never a message, and leaves
	 * that share their latest snapshot are followed once. Roots are grouped into checkouts the way resume does: a root
	 * a restore moved to is the root it moved from, taking the branch's restores from the newest back. Resume compares
	 * canonical paths where this compares the recorded ones, so a checkout reached through a symbolic link can keep one
	 * snapshot more than resume needs and never fewer. A head that records a partly restored worktree also keeps the
	 * snapshot it lacks, named in `degraded_from`, for {@link DEGRADED_RESTORE_RETENTION_DAYS} (#4922).
	 */
	private sessionHeads(): string {
		const t = this.tables;
		return `WITH RECURSIVE
			open_anchors(session_id, seq) AS (SELECT DISTINCT session_id, anchor_seq FROM ${t.sessionLinks} WHERE children = 0 AND anchor_seq IS NOT NULL),
			branch(session_id, start_seq, root, snapshot_id, restore_from, restore_to, degraded_from, degraded_since, prev_seq, depth) AS (
				SELECT ref.session_id, ref.seq, ref.root, ref.snapshot_id, ref.restore_from, ref.restore_to, ref.degraded_from, ref.degraded_since, ref.prev_seq, 0 FROM open_anchors AS anchor JOIN ${t.sessionRefs} AS ref ON ref.session_id = anchor.session_id AND ref.seq = anchor.seq
				UNION ALL
				SELECT branch.session_id, branch.start_seq, ref.root, ref.snapshot_id, ref.restore_from, ref.restore_to, ref.degraded_from, ref.degraded_since, ref.prev_seq, branch.depth + 1 FROM branch JOIN ${t.sessionRefs} AS ref ON ref.session_id = branch.session_id AND ref.seq = branch.prev_seq
			),
			walk(session_id, start_seq, root, current, position) AS (
				SELECT DISTINCT session_id, start_seq, root, root, -1 FROM branch
				UNION ALL
				SELECT walk.session_id, walk.start_seq, walk.root, CASE WHEN restore.restore_to = walk.current THEN restore.restore_from ELSE walk.current END, restore.depth
				FROM walk JOIN branch AS restore ON restore.session_id = walk.session_id AND restore.start_seq = walk.start_seq AND restore.restore_to IS NOT NULL
					AND restore.depth = (SELECT min(later.depth) FROM branch AS later WHERE later.session_id = walk.session_id AND later.start_seq = walk.start_seq AND later.restore_to IS NOT NULL AND later.depth > walk.position)
			),
			checkout(session_id, start_seq, root, original) AS (
				SELECT session_id, start_seq, root, current FROM walk AS last WHERE position = (SELECT max(other.position) FROM walk AS other WHERE other.session_id = last.session_id AND other.start_seq = last.start_seq AND other.root = last.root)
			),
			session_heads(session_id, start_seq, original, depth) AS (
				SELECT branch.session_id, branch.start_seq, checkout.original, min(branch.depth) FROM branch JOIN checkout ON checkout.session_id = branch.session_id AND checkout.start_seq = branch.start_seq AND checkout.root = branch.root GROUP BY branch.session_id, branch.start_seq, checkout.original
			),
			head_records(session_id, snapshot_id, degraded_from, degraded_since) AS (
				SELECT branch.session_id, branch.snapshot_id, branch.degraded_from, branch.degraded_since FROM session_heads JOIN checkout ON checkout.session_id = session_heads.session_id AND checkout.start_seq = session_heads.start_seq AND checkout.original = session_heads.original JOIN branch ON branch.session_id = checkout.session_id AND branch.start_seq = checkout.start_seq AND branch.root = checkout.root AND branch.depth = session_heads.depth
			)
			SELECT session_id, snapshot_id FROM head_records
			UNION SELECT session_id, degraded_from FROM head_records WHERE degraded_from IS NOT NULL AND (degraded_since IS NULL OR degraded_since > ${this.dialect.nowSeconds} - ${DEGRADED_PIN_SECONDS})`;
	}

	/**
	 * The next {@link SNAPSHOT_COLLECTION_BATCH} blobs whose `created_at` is at least `minimumAge` whole seconds behind
	 * the database clock and that are `unreferenced`, oldest first, after `after`.
	 */
	private page(
		transaction: SqliteExecutor,
		minimumAge: number,
		unreferenced: string,
		after: PageRow | undefined,
	): Promise<PageRow[]> {
		const t = this.tables;
		return after === undefined
			? transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at > 0 AND created_at <= ${this.dialect.nowSeconds} - ? AND ${unreferenced} ORDER BY created_at, hash LIMIT ?`,
					minimumAge,
					SNAPSHOT_COLLECTION_BATCH,
				)
			: transaction.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at > 0 AND created_at <= ${this.dialect.nowSeconds} - ? AND (created_at, hash) > (?, ?) AND ${unreferenced} ORDER BY created_at, hash LIMIT ?`,
					minimumAge,
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
	 * the lock, waiting for it on `pace` when one is given.
	 */
	async claimCollection(intervalSeconds: number, holder: string, pace?: BackgroundCollectionPace): Promise<boolean> {
		const due = `id = 1 AND (claimed_at IS NULL OR (finished_at IS NULL AND claimed_at <= ${this.dialect.nowSeconds} - ?) OR (finished_at IS NOT NULL AND finished_at <= ${this.dialect.nowSeconds} - ?))`;
		const lease = SNAPSHOT_COLLECTION_LEASE_SECONDS;
		if (!(await this.database.get(`SELECT id FROM ${this.tables.collection} WHERE ${due}`, lease, intervalSeconds)))
			return false;
		const { changes } = await this.write(pace, (transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET claimed_at = ${this.dialect.nowSeconds}, holder = ?, finished_at = NULL, deleted = NULL, error_code = NULL WHERE ${due}`,
				holder,
				lease,
				intervalSeconds,
			),
		);
		return changes === 1;
	}

	private renewClaim(transaction: SqliteExecutor, holder: string): Promise<unknown> {
		return transaction.run(
			`UPDATE ${this.tables.collection} SET claimed_at = ${this.dialect.nowSeconds} WHERE id = 1 AND holder = ?`,
			holder,
		);
	}

	/**
	 * Records how `holder`'s claimed collection ended; a later claim by another holder is left alone. Waits for the
	 * write lock on `pace` when one is given.
	 */
	async recordCollection(
		holder: string,
		outcome: { readonly deleted: number; readonly errorCode: string | null },
		pace?: BackgroundCollectionPace,
	): Promise<void> {
		await this.write(pace, (transaction) =>
			transaction.run(
				`UPDATE ${this.tables.collection} SET finished_at = ${this.dialect.nowSeconds}, deleted = ?, error_code = ? WHERE id = 1 AND holder = ?`,
				outcome.deleted,
				outcome.errorCode,
				holder,
			),
		);
	}

	/** Waits between two batches: on `pace` in the background, otherwise until the event loop has run once. */
	private betweenBatches(pace: BackgroundCollectionPace | undefined): Promise<void> {
		return pace === undefined ? yieldToEventLoop() : pace.wait(0);
	}

	/**
	 * Runs `body` in a write transaction. With `pace`, the transaction never waits for a write lock another connection
	 * holds: it is refused at once and tried again after a wait on `pace` that doubles each time, so the process can
	 * exit meanwhile; once the waits add up to {@link SNAPSHOT_COLLECTION_LEASE_SECONDS}, it rejects with the refusal.
	 */
	private async write<T>(
		pace: BackgroundCollectionPace | undefined,
		body: (transaction: SqliteExecutor) => Promise<T>,
	): Promise<T> {
		if (pace === undefined) return this.database.transaction(body);
		let waited = 0;
		for (let delay = SNAPSHOT_COLLECTION_LOCK_RETRY_FIRST_MS; ; ) {
			try {
				return await this.database.transaction(body, { lockWaitMs: 0 });
			} catch (error) {
				if (!(error instanceof StorageWriteLockTimeoutError) || waited >= SNAPSHOT_COLLECTION_LEASE_SECONDS * 1_000)
					throw error;
			}
			await pace.wait(delay);
			pace.signal?.throwIfAborted();
			waited += delay;
			delay = Math.min(delay * 2, SNAPSHOT_COLLECTION_LOCK_RETRY_MAX_MS);
		}
	}
}
