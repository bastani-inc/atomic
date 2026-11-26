import { transactionFinisher } from "../storage/added-exports.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
} from "../storage/database.js";
import { dialectOf, type StorageDialect, type StorageJsonSource, type StorageTrigger } from "../storage/dialect.js";
import { StorageWriteLockTimeoutError } from "../storage/errors.js";
import { applyStorageMigrations, withShortSchemaLockWaits } from "../storage/migrations.js";
import { renderStorageIdentifiers, storageMigrationTable, validateStoragePrefix } from "../storage/prefix.js";
import { type StorageSchemaCatalog, schemaCatalogOf } from "../storage/schema-catalog.js";
import { statementBatch } from "../storage/statement-batches.js";
import type { BatchWrite } from "../storage/statement-sequence.js";
import type { WorkspaceCollectionError } from "./errors.ts";
import {
	entriesIndexComplete,
	forkSegmentsTable,
	forkSessionLink,
	legacyForkLinksTriggerName,
	parentColumns,
	snapshotEntryCondition,
} from "./fork-snapshot-index.ts";
import type { SnapshotBlob, SnapshotBlobStore, WorktreeSnapshot } from "./types.ts";

/** A trigger or view, by its exact name. */
interface SchemaObject {
	readonly type: "trigger" | "view";
	readonly name: string;
}

/**
 * The key under which a failed rename's error carries the trigger or view that stopped it, once confirmed in the
 * database (#5622); `WorkspaceCollectionError` names it in its hint. A `Symbol.for` key, shared without an import.
 */
const RENAME_BLOCKER = Symbol.for("atomic-snapshots/rename-blocker@1");

/** What SQLite writes after an object's name when the object stops a schema change only once the change is made. */
const RENAME_BLOCKER_WHEN = [" after rename", " after drop column"];

/**
 * Every trigger or view that `error`, a failed rename, or an error it wraps can name. SQLite names a trigger or view
 * that no longer compiles, such as one that refers to a dropped table, as `error in <type> <name>[ <when>]: <reason>`,
 * and drivers add their own prefix. The name is not quoted, so `error in view sales after rename: …` can name a view
 * `sales after rename` or a view `sales`, and a name can hold `: `. Only the database can tell which object it is.
 */
function renameBlockerCandidates(error: unknown): SchemaObject[] {
	const candidates: SchemaObject[] = [];
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++, current = current.cause)
		for (const match of current.message.matchAll(/\berror in (trigger|view) /gu)) {
			const type = match[1] as SchemaObject["type"];
			const rest = current.message.slice(match.index + match[0].length);
			for (let end = rest.indexOf(": "); end !== -1; end = rest.indexOf(": ", end + 1)) {
				const name = rest.slice(0, end);
				candidates.push({ type, name });
				for (const when of RENAME_BLOCKER_WHEN)
					if (name.endsWith(when)) candidates.push({ type, name: name.slice(0, -when.length) });
			}
		}
	return candidates;
}

/** Every blob hash a snapshot needs to be restored: its chain's patches and its bundle. */
export function snapshotBlobHashes(snapshot: WorktreeSnapshot): string[] {
	const hashes = snapshot.chain.flatMap((link) => (link.patch === null ? [] : [link.patch]));
	if (snapshot.bundle) hashes.push(snapshot.bundle.blob);
	return [...new Set(hashes)];
}

/**
 * Compares two blob hashes as `ORDER BY hash` with the dialect's `byteOrderCollation` does: the hashes are ASCII (hex
 * digests), whose UTF-16 code unit order is their byte order.
 */
function byteOrder(first: string, second: string): number {
	return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * The blob hashes a recorded snapshot names, read as the reference index reads them: a write never fails on a record
 * whose chain or bundle is not well formed, which references nothing it cannot read.
 */
function wellFormedBlobHashes(snapshot: WorktreeSnapshot): string[] {
	const chain: readonly WorktreeSnapshot["chain"][number][] = Array.isArray(snapshot?.chain) ? snapshot.chain : [];
	const hashes = chain.flatMap((link) => (typeof link?.patch === "string" ? [link.patch] : []));
	if (typeof snapshot?.bundle?.blob === "string") hashes.push(snapshot.bundle.blob);
	return hashes;
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
 * The tables of one blob table's reference index, all under the blob table's prefix. Triggers on the session store's
 * tables, and on the tables a workflow run journal of an earlier release left in the database, keep them current in the
 * same transaction as each write, so collection reads only these tables and never a journal or a session.
 */
export interface SnapshotIndexTables {
	/**
	 * `(hash, bytes, data, created_at, chunks)`: one row per blob. A blob of at most {@link SNAPSHOT_BLOB_CHUNK_BYTES}
	 * is in `data` (`chunks` 0, as every blob written before chunks was); a larger one has an empty `data` and its bytes
	 * in `chunks` rows of {@link SnapshotIndexTables.blobChunks}.
	 */
	readonly blobs: string;
	/**
	 * `(hash, idx, data)`: the chunks of each blob larger than {@link SNAPSHOT_BLOB_CHUNK_BYTES}, in order (#4954). An
	 * ordinary table whose primary key is an index of its own, never `WITHOUT ROWID` (#5541): see
	 * {@link chunkTableDefinition}.
	 */
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

/** Why collection left a legacy chunk table in place. Byte estimates are from the decision, before any partial copy was discarded. */
export type PendingChunkMove =
	| {
			readonly reason: "free-space";
			readonly remainingBytes: number;
			readonly requiredFreeBytes: number;
			readonly freeBytes: number;
	  }
	| { readonly reason: "space-unknown"; readonly remainingBytes: number; readonly automaticLimitBytes: number };

export type SnapshotCollectionSkipReason = "disabled" | "unsupported" | "in-progress" | "not-due";

/** How one automatic collection ended. Its promise never rejects: a failure is an outcome, reported once. */
export type SnapshotCollectionOutcome =
	| { readonly status: "skipped"; readonly reason: SnapshotCollectionSkipReason }
	| { readonly status: "collected"; readonly deleted: readonly string[]; readonly pendingChunkMove?: PendingChunkMove }
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

/** Aged blobs one page of a collection examines, read from the age index in one statement. */
export const SNAPSHOT_COLLECTION_BATCH = 256;

/**
 * The most blobs one delete batch of a collection deletes, in one write transaction (#5530). Deleting a blob also
 * deletes its chunks. On a chunk table an earlier release created `WITHOUT ROWID`, until collection moves it (#5541),
 * finding them reads whole chunks of the rows each seek compares: about 3.5 ms per blob on a large store with its
 * pages cached, so a batch of this many takes about 30 ms.
 * The transaction also checks again, in one statement, the sessions that reference the batch's blobs: at most
 * {@link SNAPSHOT_COLLECTION_SESSION_REFS} snapshot entries of them.
 */
export const SNAPSHOT_COLLECTION_DELETE_BATCH = 8;

/**
 * The most snapshot entries of sessions one collection statement walks to find the snapshots those sessions retain
 * (#5530). Each session's retained snapshots are found by walking the snapshot entries on its open branches, about
 * 2 µs per entry with its pages cached, so a statement over this many takes a few milliseconds, and the event loop
 * gets a turn between statements. A session with more entries than this is walked in a statement of its own, and so
 * is a blob whose sessions hold more together when its delete batch checks them again.
 */
export const SNAPSHOT_COLLECTION_SESSION_REFS = 2_048;

/**
 * The most bytes of legacy blobs one write transaction of a collection stamps or moves. A blob stored before blob ages
 * has an unknown age, which collection stamps; changing one column rewrites the whole row on SQLite, its
 * blob included, and holds the writer for as long as that takes, so a stamping transaction stops at this many bytes of
 * blobs. An in-row blob larger than {@link SNAPSHOT_BLOB_CHUNK_BYTES} is moved to chunks regardless of age,
 * at most this many bytes per transaction. Publishing frees its old value while holding the writer, with time
 * proportional to that value's size.
 */
export const SNAPSHOT_LEGACY_STAMP_BYTES = 16 * SNAPSHOT_BLOB_CHUNK_BYTES;

/**
 * The most chunk rows one write transaction copies or frees while collection moves a chunk table an earlier release
 * created `WITHOUT ROWID` to the row layout (#5541). Each costs a read of its 1 MiB, cold on a first move, under the
 * write lock.
 */
export const SNAPSHOT_CHUNK_MOVE_ROWS = 4;

/**
 * The free space a chunk table's move to the row layout leaves on the file system of a SQLite database file
 * beyond its copy, at least (#5694): the move starts only when the disk has room for the copy, its write-ahead log and
 * this much more, so other writes keep room on the disk.
 */
export const SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES = 64 * 1024 * 1024;

// Four 1 MiB chunks per offline transaction, plus space for b-tree pages and WAL framing.
const OFFLINE_CHUNK_LOG_ALLOWANCE = 16 * SNAPSHOT_BLOB_CHUNK_BYTES;

/**
 * Whether `error`, or a failure it wraps, says the database's disk is full or failed to read or write: SQLite's
 * `SQLITE_FULL` or `SQLITE_IOERR` and its extended codes (node:sqlite's `errcode`, libSQL's code or `rawCode`), as a
 * libSQL server answers when its disk fills, or PostgreSQL's `disk_full` (53100) or `io_error` (58030).
 */
function isStorageSpaceFailure(error: unknown): boolean {
	const seen = new Set<object>();
	for (let cause = error; typeof cause === "object" && cause !== null && !seen.has(cause); ) {
		seen.add(cause);
		const { code, errcode, rawCode } = cause as { code?: unknown; errcode?: unknown; rawCode?: unknown };
		if (typeof code === "string" && /^(?:SQLITE_FULL|SQLITE_IOERR(?:_\w+)?|53100|58030)$/.test(code)) return true;
		const number = errcode ?? rawCode;
		if (typeof number === "number" && ((number & 0xff) === 13 || (number & 0xff) === 10)) return true;
		cause = (cause as { cause?: unknown }).cause;
	}
	return false;
}

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
	/** The existing space check deferred layout maintenance; garbage collection itself succeeded. */
	readonly onPendingChunkMove?: (pending: PendingChunkMove) => void;
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
 * How long the light statements of a sweep, such as reading what walking a session costs, may hold the event loop
 * together before the sweep gives it a turn, in milliseconds. Counting a session's snapshot entries reads them: a few
 * milliseconds for a large session whose pages are not cached, so each session is counted in a statement of its own.
 */
const SWEEP_TURN_MS = 8;

/**
 * How long a sweep goes without a write before it renews its claim in a transaction of its own: a quarter of the claim
 * lease, so pages with nothing to delete, which write nothing else, never let the lease run out.
 */
const SWEEP_CLAIM_RENEWAL_MS = (SNAPSHOT_COLLECTION_LEASE_SECONDS * 1_000) / 4;

/** A blob a sweep may delete, with the sessions whose records reference it. */
interface SweepCandidate {
	readonly hash: string;
	readonly sessions: readonly string[];
}

/** Blobs a sweep deletes in one write transaction, with the sessions whose records referenced them when it walked them. */
interface SweepDeleteBatch {
	readonly hashes: readonly string[];
	readonly sessions: readonly string[];
}

/**
 * Groups `costs`' sessions, in order, into groups whose costs add up to at most {@link SNAPSHOT_COLLECTION_SESSION_REFS};
 * a session that costs more is a group of its own.
 */
function sessionGroups(costs: ReadonlyMap<string, number>): string[][] {
	const groups: string[][] = [];
	let group: string[] = [];
	let total = 0;
	for (const [session, cost] of costs) {
		if (group.length > 0 && total + cost > SNAPSHOT_COLLECTION_SESSION_REFS) {
			groups.push(group);
			group = [];
			total = 0;
		}
		group.push(session);
		total += cost;
	}
	if (group.length > 0) groups.push(group);
	return groups;
}

/**
 * The turns of the event loop between the steps of a sweep that hold it, such as a statement that walks sessions, a
 * delete batch or a page: {@link next} gives the loop a turn when a step has held it since the last turn, then checks
 * the sweep's abort signal.
 */
class SweepTurns {
	private readonly signal?: AbortSignal;
	private readonly yieldTurn: () => Promise<void>;
	private holding = false;
	private turnedAt = performance.now();

	constructor(options: { readonly signal?: AbortSignal }, yieldTurn: () => Promise<void>) {
		this.signal = options.signal;
		this.yieldTurn = yieldTurn;
	}

	async next(): Promise<void> {
		if (this.holding) {
			this.holding = false;
			await this.yieldTurn();
			this.turnedAt = performance.now();
		}
		this.signal?.throwIfAborted();
	}

	/** Records that a step held the event loop since the last turn. */
	held(): void {
		this.holding = true;
	}

	/** Gives the event loop a turn once the light steps since the last one have held it for {@link SWEEP_TURN_MS}. */
	async light(): Promise<void> {
		if (performance.now() - this.turnedAt >= SWEEP_TURN_MS) this.holding = true;
		await this.next();
	}
}

/**
 * What one sweep has read about the sessions that reference its candidates (#5530): how many snapshot entries walking
 * each costs, and the blobs the snapshots of those it walked retain. Only nominates candidates: each delete batch reads
 * its sessions again in its transaction.
 */
class SweepSessions {
	private readonly costs = new Map<string, number>();
	private readonly walked = new Set<string>();
	private readonly retained = new Set<string>();

	/** Which of `sessions` this sweep has not walked yet. */
	unwalked(sessions: Iterable<string>): string[] {
		return [...new Set(sessions)].filter((session) => !this.walked.has(session));
	}

	cost(costs: ReadonlyMap<string, number>): void {
		for (const [session, cost] of costs) this.costs.set(session, cost);
	}

	/** Records that `sessions` were walked and that their retained snapshots reference `hashes`. */
	retain(sessions: readonly string[], hashes: readonly string[]): void {
		for (const session of sessions) this.walked.add(session);
		for (const hash of hashes) this.retained.add(hash);
	}

	retains(hash: string): boolean {
		return this.retained.has(hash);
	}

	/**
	 * `candidates` in delete batches, in order, of at most {@link SNAPSHOT_COLLECTION_DELETE_BATCH} blobs whose sessions
	 * cost at most {@link SNAPSHOT_COLLECTION_SESSION_REFS} to walk together; a candidate whose own sessions cost more
	 * is a batch of its own.
	 */
	batches(candidates: readonly SweepCandidate[]): SweepDeleteBatch[] {
		const batches: SweepDeleteBatch[] = [];
		let batch: string[] = [];
		let sessions = new Set<string>();
		let total = 0;
		const added = (candidate: SweepCandidate) =>
			candidate.sessions.reduce(
				(sum, session) => (sessions.has(session) ? sum : sum + (this.costs.get(session) ?? 1)),
				0,
			);
		for (const candidate of candidates) {
			if (
				batch.length === SNAPSHOT_COLLECTION_DELETE_BATCH ||
				(batch.length > 0 && total + added(candidate) > SNAPSHOT_COLLECTION_SESSION_REFS)
			) {
				batches.push({ hashes: batch, sessions: [...sessions] });
				batch = [];
				sessions = new Set();
				total = 0;
			}
			total += added(candidate);
			batch.push(candidate.hash);
			for (const session of candidate.sessions) sessions.add(session);
		}
		if (batch.length > 0) batches.push({ hashes: batch, sessions: [...sessions] });
		return batches;
	}
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
	/**
	 * The row that says the source's triggers index what this build's do, and that no build before 0.9.88 writes.
	 * Without it, triggers of the source's names are an older build's, which index less, and this build installs its own
	 * and indexes the table again (#5065). Builds 0.9.88 and 0.9.89 write it as `(0, 0)` when they install the triggers
	 * and read only that it exists. This build writes it as {@link PUBLISHED_VERSION}, and on SQLite, which builds before
	 * 0.9.88 also open, only once its own backfill of the source is done, so that builds 0.9.88 and 0.9.89 never trust
	 * rows a build before 0.9.88 indexed during this build's backfill: they install their own triggers and index the
	 * table again instead (#5558).
	 */
	readonly version?: string;
	/**
	 * The progress row of this build's own backfill of the source, which no older build writes (#5558). An older build
	 * that takes this build's triggers for its own indexes the rows it backfills with statements that index less, and
	 * advances only the source's row: the source is backfilled only once this row's progress reaches its watermark too,
	 * and this build indexes those rows again. On SQLite, a source a build of 0.9.88 or 0.9.89 installed is trusted once
	 * its backfill is done, as those builds index what this build does; one whose backfill is not done is indexed again
	 * by this build from its first row, as a build before 0.9.88 may have indexed some of it.
	 */
	readonly own?: string;
	/**
	 * Text that the SQL of every trigger this build installs for the source holds, and no older build's does (#5558).
	 * Builds 0.9.88 and 0.9.89 install triggers without it, and their pending trigger does not move {@link own} back. On
	 * SQLite, which builds before 0.9.88 also open, an index this build installed is this build's only while every
	 * trigger it has holds the text: such a build installs a lost trigger again, keeps the triggers it finds, some of
	 * them the same SQL in every build, empties the index and indexes the table its way. Without the text everywhere,
	 * this build indexes the table again. A takeover installs this build's triggers before its backfill relies on its
	 * own progress.
	 */
	readonly marker?: string;
	/**
	 * Text that only this build's SQL of the trigger `trigger` holds. On SQLite, which older builds also open, a trigger
	 * of that name without it is an older build's, installed after this build's went missing, so the source is indexed
	 * again as an older build's (#5558).
	 */
	readonly signature?: { readonly trigger: string; readonly text: string };
}

interface SourceState {
	readonly source: IndexSource;
	readonly installed: boolean;
	readonly backfilled: boolean;
	readonly deferred: boolean;
	/** Installed by another build whose index this build does not trust: an upgrade, or an older build's again. */
	readonly foreign: boolean;
	/**
	 * On SQLite, installed with {@link IndexSource.version} but not backfilled, as by a build of 0.9.88 or 0.9.89 whose
	 * backfill is not done. This build's backfill removes the row, installs its own triggers and indexes the source again
	 * from its first row (#5558).
	 */
	readonly takeover: boolean;
	readonly retired?: readonly string[];
}

/**
 * The watermark and progress of a source's {@link IndexSource.version} row as this build writes it: on SQLite once its
 * own backfill of the source is done, on Postgres when it installs the source's triggers (#5558). Builds 0.9.88 and
 * 0.9.89 write the row as `(0, 0)`.
 */
const PUBLISHED_VERSION = 1;

/** Receipts for physical session-index generations. Released builds read only their own source names. */
export const SESSION_INDEX_RETIRED_PREFIX = "session-entries@retired:";
type SessionIndexReset = (
	tx: SqliteExecutor,
	tables: SnapshotIndexTables,
	triggers: readonly string[],
) => Promise<boolean>;

/**
 * A row that a development build marked a source with while it removed the source's index in batches. An index an
 * older build installed while it was there is never trusted as that build's finished index (#5558).
 */
const rebuildRow = (source: IndexSource) => `${source.name}@rebuild`;

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

/** The progress row of this build's own backfill of the session entries (#5558). */
const ENTRIES_OWN_PROGRESS = "session-entries@own-progress";

/** `trigger`, its SQL holding `marker` in a comment that changes nothing it does (#5558). */
function withMarker(trigger: StorageTrigger, marker: string): StorageTrigger {
	const [first, ...rest] = trigger.statements;
	return { ...trigger, statements: [`/* ${marker} */ ${first}`, ...rest] };
}

/**
 * The tables whose rows reference snapshot blobs, and how each is indexed. `forkSegments` names the sessions' fork
 * segments table when it exists (#6560): the backfill of the session entries then also links an entry whose parent
 * the session inherits, as the session store does when it writes one (`forkLinkWrites`).
 */
function indexSources(
	prefix: string,
	t: SnapshotIndexTables,
	d: StorageDialect,
	forkSegments?: string,
): readonly IndexSource[] {
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
	const triggerEntry = `(SELECT ${entryColumns.map((name) => `NEW.${name} AS ${name}`).join(", ")}, ${parentColumns(d, "NEW.entry_json")})`;
	const storedEntry = `(SELECT ${entryColumns.join(", ")}, ${parentColumns(d, "entry_json")} FROM ${entries} WHERE ${d.rowOrder()} = ?)`;
	const indexComplete = entriesIndexComplete(t.sources);
	const newRowOrder = d.rowOrder("NEW");
	const forkLink = (rows: string) =>
		forkSegments === undefined ? [] : [forkSessionLink(t.sessionLinks, forkSegments, rows, isSnapshot)];
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
					// This build's own progress follows, so an older build's backfill of these rows is never trusted (#5558).
					`UPDATE ${t.sources} SET watermark = ${newRowOrder} WHERE source = '${ENTRIES_OWN_PROGRESS}' AND watermark < ${newRowOrder}`,
					`UPDATE ${t.sources} SET backfilled_through = ${newRowOrder} - 1 WHERE source = '${ENTRIES_OWN_PROGRESS}' AND backfilled_through >= ${newRowOrder}`,
				],
				`NOT COALESCE(${indexComplete}, ${d.literals.true})`,
			),
			createTrigger(`${entries}_snapshot_refs_delete`, "DELETE", entries, [
				`UPDATE ${t.sessionLinks} SET children = children - 1 WHERE session_id = OLD.session_id AND children > 0 AND entry_id = (SELECT parent_id FROM ${t.sessionLinks} WHERE session_id = OLD.session_id AND seq = OLD.seq)`,
				`DELETE FROM ${t.sessionLinks} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
				`DELETE FROM ${t.sessionRefs} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
				`DELETE FROM ${t.sessionRecords} WHERE session_id = OLD.session_id AND seq = OLD.seq`,
			]),
		].map((trigger) => withMarker(trigger, ENTRIES_OWN_PROGRESS)),
		backfill: [],
		rowwise: [...sessionLink(storedEntry), ...forkLink(storedEntry), ...sessionRecord(storedEntry)],
		// The triggers that index degraded pins (#4922). Older builds install theirs under the same names (#5065).
		version: "session-entries@degraded-pins",
		own: ENTRIES_OWN_PROGRESS,
		marker: ENTRIES_OWN_PROGRESS,
		signature: { trigger: `${entries}_snapshot_refs`, text: "degraded_from" },
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
 * Creates a chunk table named `table` unless it exists. An ordinary table, whose primary key is an index of its own:
 * a lookup reads that small index, then only the row it finds. A `WITHOUT ROWID` table, as earlier releases created,
 * keeps each row in its key's b-tree, so a seek reads the whole record of every 1 MiB row it compares on its way, and
 * every lookup, a delete's of a blob without chunks included, read several chunks (#5541). On Postgres both are the
 * same heap table.
 */
function chunkTableDefinition(table: string, dialect: StorageDialect): string {
	const { int, text, blob } = dialect.types;
	return `CREATE TABLE IF NOT EXISTS ${table} (hash ${text} NOT NULL, idx ${int} NOT NULL, data ${blob} NOT NULL, PRIMARY KEY (hash, idx))${dialect.tableOptions}`;
}

/** The trigger that deletes a blob's chunks with it, in the statement that deletes it, whoever deletes it. */
const chunksDeleteTrigger = (t: SnapshotIndexTables) =>
	createTrigger(`${t.blobs}_chunks_delete_all`, "DELETE", t.blobs, [
		`DELETE FROM ${t.blobChunks} WHERE hash = OLD.hash`,
	]);

/**
 * The tables of a chunk table's move to the row layout (#5541): `next`, the new table it fills, which then takes the
 * chunk table's name, and `retired`, the old table under its new name until it is emptied and dropped.
 */
const chunkMoveTables = (t: SnapshotIndexTables) =>
	({ next: `${t.blobChunks}_next`, retired: `${t.blobChunks}_retired` }) as const;

/**
 * What {@link blobChunkWrites} reads once the chunk table exists: whether the blob table has its `chunks` column, and
 * whether the trigger that deletes a blob's chunks with it is there.
 */
function blobChunkProbes(transaction: SqliteExecutor, t: SnapshotIndexTables, dialect: StorageDialect) {
	const column = dialect.columnExists(t.blobs, "chunks");
	const trigger = dialect.schemaObjects([`${t.blobs}_chunks_delete_all`]);
	return [
		async () => (await transaction.get(column.sql, ...column.params)) !== undefined,
		async () => (await transaction.get(trigger.sql, ...trigger.params)) !== undefined,
	] as const;
}

/** The blob table's `chunks` column and the chunks' delete trigger, those of them that {@link blobChunkProbes} missed. */
function blobChunkWrites(
	t: SnapshotIndexTables,
	dialect: StorageDialect,
	[column, trigger]: readonly [boolean, boolean],
): BatchWrite[] {
	return [
		!column && `ALTER TABLE ${t.blobs} ADD COLUMN chunks ${dialect.types.int} NOT NULL DEFAULT 0`,
		!trigger && dialect.dropTrigger(`${t.blobs}_chunks_delete`, t.blobs, true),
		!trigger && dialect.renderTrigger(chunksDeleteTrigger(t)),
	];
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
	const found = await statementBatch(
		transaction,
		[chunkTableDefinition(t.blobChunks, dialect)],
		blobChunkProbes(transaction, t, dialect),
	);
	await statementBatch(transaction, blobChunkWrites(t, dialect, found), []);
}

/**
 * Creates the blob table and the tables of its reference index that are missing, reading what each step needs
 * together, so on a SQLite file connection the setup waits for the connection's thread three times.
 */
async function createSnapshotIndexTables(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
): Promise<void> {
	const { int, text, blob } = dialect.types;
	const strict = dialect.tableOptions;
	const keyed = dialect.withoutRowidTableOptions;
	const ageColumn = dialect.columnExists(t.blobs, "created_at");
	const [age] = await statementBatch(
		transaction,
		[
			`CREATE TABLE IF NOT EXISTS ${t.blobs} (hash ${text} PRIMARY KEY, bytes ${int} NOT NULL, data ${blob} NOT NULL, created_at ${int} NOT NULL DEFAULT (${dialect.nowSeconds}))${strict}`,
		],
		[() => transaction.get<SqliteRow & { default_value: SqliteValue }>(ageColumn.sql, ...ageColumn.params)],
	);
	const [column, trigger, ...refColumns] = await statementBatch(
		transaction,
		[
			// Unknown ages are stamped in short collection batches, never by rewriting the table at open.
			!age && `ALTER TABLE ${t.blobs} ADD COLUMN created_at ${int} NOT NULL DEFAULT 0`,
			`
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
	`,
			chunkTableDefinition(t.blobChunks, dialect),
		],
		[...blobChunkProbes(transaction, t, dialect), ...sessionRefColumnProbes(transaction, t, dialect)],
	);
	await statementBatch(
		transaction,
		[
			...blobChunkWrites(t, dialect, [column, trigger]),
			...(age && String(age.default_value) !== "0" ? blobMaintenanceIndexes(t) : []),
			...sessionRefColumnWrites(t, prefix, dialect, refColumns),
		],
		[],
	);
}

/** The indexes collection and the chunk-layout move look blobs up by. */
function blobMaintenanceIndexes(t: SnapshotIndexTables): string[] {
	return [
		`CREATE INDEX IF NOT EXISTS ${t.blobs}_age ON ${t.blobs} (created_at, hash)`,
		`CREATE INDEX IF NOT EXISTS ${t.blobs}_inline_size ON ${t.blobs} (chunks, hash) WHERE chunks = 0 AND length(data) > ${SNAPSHOT_BLOB_CHUNK_BYTES}`,
	];
}

async function addBlobMaintenanceIndexes(transaction: SqliteExecutor, t: SnapshotIndexTables): Promise<void> {
	await statementBatch(transaction, blobMaintenanceIndexes(t), []);
}

/** The columns of {@link SnapshotIndexTables.sessionRefs} that later builds added, with their types. */
const SESSION_REF_COLUMNS = ["prev_seq", "restore_from", "restore_to", "degraded_from", "degraded_since"] as const;

/** Whether the session references have each of {@link SESSION_REF_COLUMNS}, in its order. */
function sessionRefColumnProbes(transaction: SqliteExecutor, t: SnapshotIndexTables, dialect: StorageDialect) {
	return SESSION_REF_COLUMNS.map((name) => {
		const column = dialect.columnExists(t.sessionRefs, name);
		return async () => (await transaction.get(column.sql, ...column.params)) !== undefined;
	});
}

/**
 * Adds the columns of the session references that an index written by an earlier build lacks, as
 * {@link sessionRefColumnProbes} found them. Adding any drops the session entries' triggers and marks their index for
 * a rebuild, which collection runs before it deletes anything.
 */
function sessionRefColumnWrites(
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
	found: readonly boolean[],
): BatchWrite[] {
	const { int, text } = dialect.types;
	const types: Record<(typeof SESSION_REF_COLUMNS)[number], string> = {
		prev_seq: int,
		restore_from: text,
		restore_to: text,
		degraded_from: text,
		degraded_since: int,
	};
	const missing = SESSION_REF_COLUMNS.filter((_, index) => found[index] !== true);
	if (missing.length === 0) return [];
	// Mark the tree-aware rebuild durably, but leave its old rows untouched until completeIndex runs.
	const source = indexSources(prefix, t, dialect).find((source) => source.name === "session-entries")!;
	return [
		...missing.map((name) => `ALTER TABLE ${t.sessionRefs} ADD COLUMN ${name} ${types[name]}`),
		...source.triggers.map((trigger) => dialect.dropTrigger(trigger.name, trigger.table)),
		{
			sql: `INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, -1, -1) ${REPLACE_PROGRESS}`,
			params: [source.name],
		},
	];
}

/** Adds the columns of the session references that an index written by an earlier build lacks; see above. */
async function addSessionRefColumns(
	transaction: SqliteExecutor,
	t: SnapshotIndexTables,
	prefix: string,
	dialect: StorageDialect,
): Promise<void> {
	const found = await statementBatch(transaction, [], sessionRefColumnProbes(transaction, t, dialect));
	await statementBatch(transaction, sessionRefColumnWrites(t, prefix, dialect, found), []);
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
	reset?: SessionIndexReset,
): Promise<void> {
	const detached =
		source.name === "session-entries" &&
		(await reset?.(
			transaction,
			t,
			source.triggers.map((trigger) => trigger.name),
		));
	const withholds = withholdsVersion(dialect, source);
	const [installed] = await statementBatch(
		transaction,
		[
			...(detached
				? []
				: [
						...(source.reset ?? []).map((sql) => ({ sql, params: [] })),
						// Triggers of these names that an older build installed are replaced, not kept (#5065): dropped in one
						// script, as they are created, so a source with more triggers costs a driver no more calls.
						source.triggers.length > 0 &&
							source.triggers
								.map((trigger) => `${dialect.dropTrigger(trigger.name, trigger.table)};`)
								.join("\n"),
					]),
			source.triggers.map((trigger) => dialect.renderTrigger(trigger)).join("\n"),
			{
				sql: `INSERT INTO ${t.sources} (source, watermark, backfilled_through) SELECT ?, COALESCE(MAX(${dialect.rowOrder()}), 0), 0 FROM ${source.table} WHERE true ${REPLACE_PROGRESS}`,
				params: [source.name],
			},
			source.own !== undefined && {
				sql: `INSERT INTO ${t.sources} (source, watermark, backfilled_through) SELECT ?, watermark, 0 FROM ${t.sources} WHERE source = ? ${REPLACE_PROGRESS}`,
				params: [source.own, source.name],
			},
			{ sql: `DELETE FROM ${t.sources} WHERE source = ?`, params: [rebuildRow(source)] },
			source.version !== undefined && !withholds && publishVersion(t, source),
		],
		// A table with no row yet is backfilled as it is installed; any other is published once its backfill is done.
		source.version !== undefined && withholds
			? [
					() =>
						transaction.get<SqliteRow & { watermark: number }>(
							`SELECT watermark FROM ${t.sources} WHERE source = ?`,
							source.name,
						),
				]
			: [],
	);
	if (source.version === undefined || !withholds) return;
	await statementBatch(
		transaction,
		[
			Number(installed?.watermark) === 0
				? publishVersion(t, source)
				: { sql: `DELETE FROM ${t.sources} WHERE source = ?`, params: [source.version] },
		],
		[],
	);
}

/**
 * Whether this build writes `source`'s {@link IndexSource.version} row only once its own backfill of the source is done:
 * on SQLite, which builds before 0.9.88 also open (#5558).
 */
function withholdsVersion(dialect: StorageDialect, source: IndexSource): boolean {
	return dialect.name === "sqlite" && source.version !== undefined && source.own !== undefined;
}

/** The statement that writes `source`'s version row as this build's, its own backfill of the source being done (#5558). */
function publishVersion(t: SnapshotIndexTables, source: IndexSource): SqliteStatement {
	return {
		sql: `INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, ?, ?) ${REPLACE_PROGRESS}`,
		params: [source.version!, PUBLISHED_VERSION, PUBLISHED_VERSION],
	};
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
	reset?: SessionIndexReset,
): Promise<void> {
	for (const { source, installed, deferred } of await readSourceStates(
		transaction,
		dialect,
		t,
		indexSources(prefix, t, dialect),
	)) {
		if (!installed && !deferred) await installSource(transaction, dialect, t, source, reset);
	}
}

/** The names of `sources`' tables and triggers, whose presence `readSourceStates` reads. */
function sourceObjectNames(sources: readonly IndexSource[]): string[] {
	return sources.flatMap((source) => [source.table, ...source.triggers.map((trigger) => trigger.name)]);
}

/** The read of every source's progress rows. */
function sourceProgressRead(t: SnapshotIndexTables): SqliteStatement {
	return { sql: `SELECT source, watermark, backfilled_through FROM ${t.sources}`, params: [] };
}

/**
 * Which referencing tables exist, whether each has all its triggers and a source row, and whether its backfill is done.
 * `present`, when given, holds every table and trigger of `sources`, as an open's catalog found them: the objects are
 * not read then (#6560).
 */
async function readSourceStates(
	executor: SqliteExecutor,
	dialect: StorageDialect,
	t: SnapshotIndexTables,
	sources: readonly IndexSource[],
	listRetired = false,
	present?: ReadonlySet<string>,
	also?: { readonly names: readonly string[]; readonly found: Set<string> },
): Promise<SourceState[]> {
	// `also` asks, in the same statement, which of other objects exist, as `also.found` tells.
	const names = [...sourceObjectNames(sources), ...(also?.names ?? [])];
	// Builds before 0.9.88 open SQLite databases only, so only there can a trigger of this build's name be
	// one that indexes less.
	const sqlite = dialect.name === "sqlite";
	const signatures = sqlite ? sources.flatMap((source) => source.signature ?? []) : [];
	const markers = sqlite
		? sources.flatMap((source) =>
				source.marker === undefined
					? []
					: source.triggers.map((trigger) => ({ trigger: trigger.name, text: source.marker! })),
			)
		: [];
	const holds = (checks: readonly { readonly trigger: string; readonly text: string }[]) =>
		checks.length === 0 ? "NULL" : `CASE ${checks.map(() => "WHEN name = ? THEN instr(sql, ?) > 0").join(" ")} END`;
	const objects =
		signatures.length + markers.length === 0
			? dialect.schemaObjects(names)
			: {
					sql: `SELECT name, ${holds(signatures)} AS signed, ${holds(markers)} AS marked FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`,
					params: [...signatures, ...markers].flatMap((check) => [check.trigger, check.text]).concat(names),
				};
	const progressRead = sourceProgressRead(t);
	type ObjectRow = SqliteRow & { name: string; signed?: number | null; marked?: number | null };
	// Read together: the progress rows do not depend on the objects.
	const [objectRows, progressRows] = await statementBatch(
		executor,
		[],
		[
			() =>
				present === undefined
					? executor.all<ObjectRow>(objects.sql, ...objects.params)
					: Promise.resolve(names.filter((name) => present.has(name)).map((name): ObjectRow => ({ name }))),
			() =>
				executor.all<SqliteRow & { source: string; watermark: number; backfilled_through: number }>(
					progressRead.sql,
					...progressRead.params,
				),
		],
	);
	const found = new Set(objectRows.map((row) => row.name));
	for (const name of also?.names ?? []) if (found.has(name)) also?.found.add(name);
	// Whether each checked trigger's SQL holds this build's text; every other object reads null.
	const checked = (column: "signed" | "marked") =>
		new Map(
			objectRows
				.filter((row) => row[column] !== null && row[column] !== undefined)
				.map((row) => [row.name, Number(row[column]) === 1]),
		);
	const signed = checked("signed");
	const marked = checked("marked");
	let retired: string[] | undefined;
	const progress = new Map(
		progressRows.map((row) => {
			if (
				listRetired &&
				sqlite &&
				row.source.startsWith(SESSION_INDEX_RETIRED_PREFIX) &&
				Number(row.backfilled_through) === 0
			) {
				retired ??= [];
				retired.push(row.source);
			}
			return [row.source, row] as const;
		}),
	);
	return sources
		.filter((source) => found.has(source.table))
		.map((source) => {
			const row = progress.get(source.name);
			const version = source.version === undefined ? undefined : progress.get(source.version);
			const own = source.own === undefined ? undefined : progress.get(source.own);
			const ownDone =
				own !== undefined && row !== undefined && Number(own.backfilled_through) >= Number(row.watermark);
			// An index an older build installed while a rebuild row was there, which 0.9.87 may have indexed since (#5558).
			const reinstalled = row !== undefined && progress.has(rebuildRow(source));
			// On SQLite, a reference trigger without this build's text is a build's before 0.9.88, installed after this
			// build's went missing (#5558).
			const unsigned = source.signature !== undefined && signed.get(source.signature.trigger) === false;
			// Every trigger the source has is this build's. One a build before 0.9.88 installed again after it went
			// missing is not, even when its SQL is the same in every build otherwise (#5558).
			const mine =
				source.marker !== undefined &&
				source.triggers.every((trigger) => !found.has(trigger.name) || marked.get(trigger.name) === true);
			let foreign: boolean;
			// Whether the backfill is done for this build, besides the source's own progress row.
			let trusted: boolean;
			if (withholdsVersion(dialect, source)) {
				// This build's install whose backfill is not done yet, which holds back the version row (#5558).
				const pending = version === undefined && own !== undefined && mine;
				// A row of 0 is a build of 0.9.88 or 0.9.89's, whose finished backfill indexed what this build's does, unless
				// it installed the index while a rebuild row was there: this build takes it over then. This build publishes
				// its own once its own progress reaches the watermark, which it must still hold.
				const published = version !== undefined && Number(version.watermark) === PUBLISHED_VERSION;
				foreign = unsigned || (version === undefined && !pending) || (published && !mine);
				trusted = published ? ownDone : version !== undefined && !reinstalled;
			} else {
				// A source whose triggers an older build installed is indexed again by collection, as after an upgrade.
				foreign = unsigned || (source.version !== undefined && version === undefined) || reinstalled;
				// Rows an older build indexed with its statements past this build's own progress are not backfilled.
				trusted = own === undefined || ownDone;
			}
			const installed =
				row !== undefined &&
				!foreign &&
				Number(row.watermark) >= 0 &&
				source.triggers.every((trigger) => found.has(trigger.name));
			const backfilled =
				row !== undefined &&
				!foreign &&
				trusted &&
				Number(row.watermark) >= 0 &&
				Number(row.backfilled_through) >= Number(row.watermark);
			return {
				source,
				installed,
				backfilled,
				deferred: row !== undefined && (foreign || Number(row.watermark) === -1),
				foreign,
				takeover: withholdsVersion(dialect, source) && installed && version !== undefined && !backfilled,
				...(retired && source.name === "session-entries" ? { retired } : {}),
			};
		});
}

/**
 * The `<prefix>snapshot_blobs` table and its reference index, shared by the session stores of one database. The index
 * also counts the references a workflow run journal of an earlier release holds in the same database, so collection
 * never deletes a blob such a run still needs.
 */
export class SqlSnapshotBlobStore implements SnapshotBlobStore {
	private readonly database: SqliteDatabase;
	private readonly tables: SnapshotIndexTables;
	private readonly sources: readonly IndexSource[];
	private readonly dialect: StorageDialect;
	/** The sessions' fork segments table (#6560), which exists once shared-history forks are on. */
	private readonly forkSegments: string;
	readonly table: string;

	private constructor(
		database: SqliteDatabase,
		dialect: StorageDialect,
		tables: SnapshotIndexTables,
		sources: readonly IndexSource[],
		forkSegments = forkSegmentsTable(),
	) {
		this.database = database;
		this.dialect = dialect;
		this.tables = tables;
		this.sources = sources;
		this.forkSegments = forkSegments;
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
		const columns = [
			[t.blobs, "created_at"],
			[t.blobs, "chunks"],
			...SESSION_REF_COLUMNS.map((column) => [t.sessionRefs, column] as const),
		] as const;
		const triggers = [`${t.blobs}_chunks_delete_all`, `${t.blobs}_chunks_delete`];
		const probes = [
			...Object.values(t).map((table) => dialect.tableExists(table)),
			...columns.map(([table, column]) => dialect.columnExists(table, column)),
			dialect.schemaObjects(triggers),
		];
		// One catalog read answers the schema questions where an open read it (#6560): always on Postgres, at the first
		// question on SQLite.
		const catalog = await schemaCatalogOf(database);
		// Whether shared-history forks are on (#6560), from that catalog or asked beside the probes.
		const segments = forkSegmentsTable(prefix);
		const segmentsProbe = dialect.tableExists(segments);
		const shared =
			catalog !== undefined
				? Promise.resolve(catalog.hasTable(segments))
				: database.get(segmentsProbe.sql, ...segmentsProbe.params).then((row) => row !== undefined);
		shared.catch(() => {});
		// A versioned database checks its ledger whatever the probes find, so it does not ask them. Elsewhere the catalog
		// answers them all, in one read instead of a read each.
		const current = dialect.versionedMigrations
			? false
			: catalog !== undefined
				? Object.values(t).every((table) => catalog.hasTable(table)) &&
					columns.every(([table, column]) => catalog.hasColumn(table, column)) &&
					triggers.some((trigger) => catalog.hasObject(trigger))
				: (await Promise.all(probes.map((probe) => database.get(probe.sql, ...probe.params)))).every(
						(row) => row !== undefined,
					);
		// A versioned database always checks its ledger: a newer schema with the same tables is refused, and a step it
		// lacks, such as the index triggers, runs even when every table exists.
		if (!current) {
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
								{
									version: 5,
									up: async (transaction: SqliteExecutor, dialect: StorageDialect) => {
										await addBlobChunks(transaction, t, dialect);
										await addBlobMaintenanceIndexes(transaction, t);
									},
								},
							]
						: []),
				],
				{ table: storageMigrationTable(prefix) },
			);
		}
		const store = new SqlSnapshotBlobStore(
			database,
			dialect,
			t,
			indexSources(prefix, t, dialect, (await shared) ? segments : undefined),
			segments,
		);
		await store.installIndex(undefined, false, await schemaCatalogOf(database));
		return store;
	}

	/** Runs only layout maintenance on the offline command's dedicated, exclusively locked SQLite file connection. */
	static async moveChunksOffline(file: string, prefix = ""): Promise<void> {
		const tables = snapshotIndexTables(prefix);
		const { withOfflineSnapshotFile } = await import("../storage/offline-snapshot-file.js");
		await withOfflineSnapshotFile(file, async (database) => {
			const store = new SqlSnapshotBlobStore(database, dialectOf(database), tables, []);
			await store.checkOfflineLayout();
			await store.moveChunksToRowTable({ graceSeconds: 0 }, true);
		});
	}

	/** Don't rename away a custom index or view, or run extra triggers outside the offline batch's space budget. */
	private async checkOfflineLayout(): Promise<void> {
		const t = this.tables;
		const { next, retired } = chunkMoveTables(t);
		const erase = chunksDeleteTrigger(t);
		const conditional = { ...erase, name: `${t.blobs}_chunks_delete`, when: "OLD.chunks > 0" };
		// sqlite_schema elides IF NOT EXISTS and the final semicolon; RENAME quotes the new table name.
		const stored = (sql: string) => sql.replace(" IF NOT EXISTS", "").replace(/;$/, "");
		const layouts = [t.blobChunks, next, retired].flatMap((name) => {
			const row = stored(chunkTableDefinition(name, this.dialect));
			return [row, row.replace(`TABLE ${name} `, `TABLE "${name}" `)].flatMap((definition) => {
				const legacy = `${definition}, WITHOUT ROWID`;
				return name === next ? [definition] : name === retired ? [legacy] : [definition, legacy];
			});
		});
		const current = stored(this.dialect.renderTrigger(erase));
		const expected = new Set([...layouts, current, stored(this.dialect.renderTrigger(conditional))]);
		const objects = await this.database.all<SqliteRow & { name: string; sql: string }>(
			"SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND (instr(lower(sql), lower(?)) > 0 OR name IN (?, ?))",
			t.blobChunks,
			erase.name,
			conditional.name,
		);
		if (!objects.some((row) => row.name === t.blobChunks) || !objects.some((row) => row.sql === current))
			throw new Error(`No standard Atomic snapshot chunk store found for table ${t.blobs}.`);
		for (const row of objects)
			if (!expected.has(row.sql))
				throw new Error(`Cannot move a customized snapshot chunk layout offline (${row.name}).`);
	}

	/** Another file on this volume may have grown since admission. Check outside the write transaction, including during retirement. */
	private async requireOfflineBatchSpace(): Promise<void> {
		const free = await this.database.freeBytes?.();
		if (free === undefined || free < SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES + OFFLINE_CHUNK_LOG_ALLOWANCE)
			throw new Error("Not enough free space for another offline chunk batch and the 64 MiB reserve.");
	}

	/** The exclusive connection is the only WAL writer. Never start a second batch on a nonempty log. */
	private async checkpointChunkMove(): Promise<void> {
		const row = await this.database.get("PRAGMA wal_checkpoint(TRUNCATE)");
		if (row?.busy !== 0 || row.log !== 0)
			throw new Error("Could not truncate the offline chunk move's write-ahead log.");
	}

	/** A transcript-only handle has no snapshot sources to index. Binding it must not even inspect their tables. */
	static forTranscriptReader(database: SqliteDatabase & { readonly readOnly: true }): SqlSnapshotBlobStore {
		return new SqlSnapshotBlobStore(database, dialectOf(database), snapshotIndexTables(), []);
	}

	/**
	 * Creates the blob table and its reference index inside the caller's transaction, and indexes the referencing tables
	 * that exist, so a store that creates its own tables takes the write lock once for all of them.
	 */
	static async initialize(
		transaction: SqliteExecutor,
		prefix = "",
		dialect: StorageDialect,
		reset?: SessionIndexReset,
	): Promise<void> {
		const t = snapshotIndexTables(prefix);
		await createSnapshotIndexTables(transaction, t, prefix, dialect);
		await installMissingSources(transaction, t, prefix, dialect, reset);
	}

	/** @internal Resolve the space reading and load migration code before taking SQLite's writer lock. */
	static async prepareSessionIndexReset(database: SqliteDatabase): Promise<SessionIndexReset | undefined> {
		if (dialectOf(database).name !== "sqlite") return undefined;
		const available = await database.freeBytes?.().catch(() => undefined);
		if (available === undefined) return undefined;
		const { detachSessionIndex } = await import("./session-index-reset.js");
		return (tx, tables, triggers) => detachSessionIndex(tx, tables, triggers, available);
	}

	/**
	 * Stores every blob, in one transaction, or restarts the age of one stored already. A blob larger than
	 * {@link SNAPSHOT_BLOB_CHUNK_BYTES} is stored as chunk rows and a header row that names how many, so no statement
	 * binds more than one chunk (#4954); the chunks of a blob stored already are not written again. Unknown ages
	 * remain protected until collection stamps them.
	 */
	async putBlobs(unordered: readonly SnapshotBlob[]): Promise<void> {
		if (unordered.length === 0) return;
		// In hash order, so the rows it locks are taken in the order every other write of them takes them.
		const blobs = [...unordered].sort((first, second) => byteOrder(first.hash, second.hash));
		const now = this.dialect.nowSeconds;
		const header = `INSERT INTO ${this.table} (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, ${now}, ?) ON CONFLICT(hash) DO UPDATE SET created_at = ${now} WHERE ${this.table}.created_at > 0`;
		const chunk = `INSERT INTO ${this.tables.blobChunks} (hash, idx, data) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${this.table} WHERE hash = ?) ON CONFLICT DO NOTHING`;
		const statements: { sql: string; params: SqliteValue[] }[] = [];
		let chunked = false;
		for (const blob of blobs) {
			const { hash, data } = blob;
			if (data.byteLength <= SNAPSHOT_BLOB_CHUNK_BYTES) {
				statements.push({ sql: header, params: [hash, data.byteLength, data, 0] });
				continue;
			}
			const chunks = Math.ceil(data.byteLength / SNAPSHOT_BLOB_CHUNK_BYTES);
			chunked = true;
			for (let index = 0; index < chunks; index++) {
				const bytes = data.subarray(index * SNAPSHOT_BLOB_CHUNK_BYTES, (index + 1) * SNAPSHOT_BLOB_CHUNK_BYTES);
				statements.push({ sql: chunk, params: [hash, index, bytes, hash] });
			}
			statements.push({ sql: header, params: [hash, data.byteLength, new Uint8Array(), chunks] });
		}
		if (!chunked && this.database.batch) {
			await this.database.batch(statements);
			return;
		}
		await this.database.transaction(async (transaction) => {
			// On a pipelined connection the statements go out with the commit: one round trip after the locks.
			if (transactionFinisher(transaction)?.(statements) === true) return;
			for (const statement of statements) await transaction.run(statement.sql, ...statement.params);
		}, this.blobWrite());
	}

	/**
	 * How a put or a refresh of this table's blobs runs: a serial transaction of the blob table's own domain (#6560). On
	 * PostgreSQL it holds the database-wide lock shared, so it waits for and excludes collection, whose writes hold that
	 * lock exclusively, and the blob writers of this table exclude one another, but session writes, which hold the
	 * database-wide lock shared with their session's domain, run beside it. Rows it writes again (`created_at`) are locked
	 * in hash order, as an append's check of the blobs it records locks them (`missingBlob`), so neither waits on the
	 * other in a cycle. Its callback only uses the transaction, so a transient failure runs it again.
	 */
	private blobWrite(leading?: readonly SqliteStatement[]): SqliteTransactionOptions {
		return {
			retryTransientFailures: true,
			concurrency: { kind: "serial", domain: this.table },
			...(leading === undefined ? {} : { leading }),
		};
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
	/** Refreshes stored hashes; unknown ages stay protected until collection stamps them. False when any is missing. */
	async refreshBlobs(hashes: readonly string[]): Promise<boolean> {
		const unique = [...new Set(hashes)];
		if (unique.length === 0) return true;
		const requested = `hash IN (SELECT value FROM ${this.dialect.jsonValues("?")})`;
		const params = [JSON.stringify(unique)];
		const update = `UPDATE ${this.table} SET created_at = ${this.dialect.nowSeconds} WHERE ${requested} AND created_at > 0`;
		const present = `SELECT hash FROM ${this.table} WHERE ${requested}`;
		if (this.database.batch) {
			const [, rows] = await this.database.batch([
				{ sql: update, params },
				{ sql: present, params },
			]);
			return rows!.length === unique.length;
		}
		// The rows present, locked in hash order before the update writes them (see `blobWrite`). On a pipelined connection
		// this read goes out with the transaction's start and the update with its commit.
		const locked = {
			sql: `${present} ORDER BY hash${this.dialect.byteOrderCollation}${this.dialect.lockClause("update")}`,
			params,
		};
		return this.database.transaction(
			async (transaction) => {
				const rows = await transaction.all(locked.sql, ...locked.params);
				if (transactionFinisher(transaction)?.([{ sql: update, params }]) !== true)
					await transaction.run(update, ...params);
				return rows.length === unique.length;
			},
			this.blobWrite([locked]),
		);
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
		const missing = await this.missingBlob(transaction, snapshots);
		if (missing !== undefined) await this.refuseCollected(missing);
	}

	/** The `blobs-collected` {@link WorkspaceSnapshotError} `assertStored` rejects with for `hash`. */
	async refuseCollected(hash: string): Promise<never> {
		// Loaded only when a write is refused, so the storage entry does not load the workspace error family.
		const { WorkspaceSnapshotError } = await import("./errors.ts");
		throw new WorkspaceSnapshotError("blobs-collected", hash);
	}

	/** The blobs of `snapshots` that `assertStored` checks, each once, in the order it reports the first missing one. */
	storedHashes(snapshots: readonly WorktreeSnapshot[]): string[] {
		return [...new Set(snapshots.flatMap(wellFormedBlobHashes))];
	}

	/**
	 * The query `missingBlob` reads, for the blobs named by `source`, an SQL expression of a JSON array of hashes: the
	 * hashes this table holds in full, locked FOR SHARE in hash order. A statement that checks the blobs on the server,
	 * such as the session append function, runs it as it is (#6599).
	 */
	storedBlobsQuery(source: string): string {
		return `SELECT hash FROM ${this.table} AS b WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues(source)}) AND (chunks = 0 OR chunks = (SELECT COUNT(*) FROM ${this.tables.blobChunks} AS c WHERE c.hash = b.hash)) ORDER BY hash${this.dialect.byteOrderCollation}${this.dialect.lockClause("share")}`;
	}

	/**
	 * A query that returns a row only while this table holds every blob of `snapshots` in full, for a write planned
	 * outside a transaction to check in the request that writes it (#5077); undefined when they name no blob.
	 */
	storedFence(snapshots: readonly WorktreeSnapshot[]): SqliteStatement | undefined {
		const hashes = [...new Set(snapshots.flatMap(wellFormedBlobHashes))];
		if (hashes.length === 0) return undefined;
		return {
			sql: `SELECT 1 AS stored WHERE (SELECT COUNT(*) FROM ${this.table} AS b WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND (chunks = 0 OR chunks = (SELECT COUNT(*) FROM ${this.tables.blobChunks} AS c WHERE c.hash = b.hash))) = ?`,
			params: [JSON.stringify(hashes), hashes.length],
		};
	}

	/**
	 * The first of `snapshots`' blobs this table does not hold in full, read in `transaction`; undefined when none. The
	 * rows it finds stay locked FOR SHARE until the transaction ends, taken in hash order as a blob write takes them.
	 */
	async missingBlob(transaction: SqliteExecutor, snapshots: readonly WorktreeSnapshot[]): Promise<string | undefined> {
		const hashes = this.storedHashes(snapshots);
		if (hashes.length === 0) return undefined;
		const rows = await transaction.all<SqliteRow & { hash: string }>(
			this.storedBlobsQuery("?"),
			JSON.stringify(hashes),
		);
		const stored = new Set(rows.map((row) => row.hash));
		return hashes.find((hash) => !stored.has(hash));
	}

	/**
	 * Installs the index triggers of every referencing table that lacks them, each with a watermark, the highest rowid
	 * the table holds in the same transaction, so every row is either at or below the watermark, to be backfilled, or
	 * above it, indexed by the triggers. A table that has none yet, an empty one included, costs one watermark of 0.
	 * Resolves with the state of every referencing table.
	 */
	private async installIndex(
		pace?: BackgroundCollectionPace,
		includeDeferred = false,
		catalog?: StorageSchemaCatalog,
	): Promise<SourceState[]> {
		// The fork links trigger earlier builds of #6560 installed, asked for in the same read: dropped where found, in the
		// first write below, so a database that has it runs it no longer once a store of this build opened it.
		const legacy = this.legacyForkLinks();
		const found = new Set<string>();
		const states = await this.readStates(includeDeferred, catalog, legacy && { names: [legacy.name], found });
		let drop = legacy !== undefined && found.has(legacy.name) ? legacy : undefined;
		const dropLegacy = async (transaction: SqliteExecutor) => {
			if (drop === undefined) return;
			const { name, table } = drop;
			await withShortSchemaLockWaits(transaction, this.dialect, () =>
				transaction.exec(this.dialect.dropTrigger(name, table, true)),
			);
			drop = undefined;
		};
		const missing = states.filter((state) => !state.installed && (includeDeferred || !state.deferred));
		for (const { source } of missing) {
			const reset =
				source.name === "session-entries"
					? await SqlSnapshotBlobStore.prepareSessionIndexReset(this.database)
					: undefined;
			await this.write(pace, async (transaction) => {
				await dropLegacy(transaction);
				const [current] = await readSourceStates(transaction, this.dialect, this.tables, [source]);
				if (current === undefined || current.installed || (current.deferred && !includeDeferred)) return;
				// Its triggers lock the table: under short lock waits, so a stalled transaction never queues writers (#5218).
				await withShortSchemaLockWaits(transaction, this.dialect, () =>
					installSource(transaction, this.dialect, this.tables, source, reset),
				);
			});
		}
		if (drop !== undefined) await this.write(pace, dropLegacy);
		return missing.length === 0 ? states : this.readStates(includeDeferred);
	}

	/** The fork links trigger earlier builds of #6560 installed on the session entries, and its table. */
	private legacyForkLinks(): { readonly name: string; readonly table: string } | undefined {
		const entries = this.sources.find((source) => source.name === "session-entries");
		return entries && { name: legacyForkLinksTriggerName(entries.table), table: entries.table };
	}

	/**
	 * The state of every source, read outside a transaction. On PostgreSQL the objects and the progress rows are read in
	 * one read-only transaction whose start carries both, so they cost one round trip, not one each. An open's
	 * `catalog` answers which objects exist only when it found every one: only its positive answers are final, and a
	 * source table it lacks may have been created since (#6560). `also` asks which of other objects exist in the same
	 * read, as `readSourceStates` does.
	 */
	private readStates(
		includeDeferred: boolean,
		catalog?: StorageSchemaCatalog,
		also?: { readonly names: readonly string[]; readonly found: Set<string> },
	): Promise<SourceState[]> {
		if (this.dialect.name !== "postgres")
			return readSourceStates(
				this.database,
				this.dialect,
				this.tables,
				this.sources,
				includeDeferred,
				undefined,
				also,
			);
		const names = sourceObjectNames(this.sources);
		const present =
			catalog !== undefined && names.every((name) => catalog.hasObject(name))
				? new Set([...names, ...(also?.names ?? []).filter((name) => catalog.hasObject(name))])
				: undefined;
		return this.database.transaction(
			(transaction) =>
				readSourceStates(transaction, this.dialect, this.tables, this.sources, includeDeferred, present, also),
			{
				readOnly: true,
				retryTransientFailures: true,
				leading: [
					...(present === undefined ? [this.dialect.schemaObjects([...names, ...(also?.names ?? [])])] : []),
					sourceProgressRead(this.tables),
				],
			},
		);
	}

	/**
	 * Indexes the rows that referencing tables held before their triggers were installed, in transactions of
	 * {@link SNAPSHOT_INDEX_BACKFILL_BATCH} rows, so that the index covers every reference. A one-time cost in the number
	 * of existing rows, paid in the background by the first collection; resumes where it stopped. Does nothing once the
	 * index is complete. Yields to the event loop after every batch, so the next batch, of the same table or another,
	 * or what follows the index, such as a sweep's first batch, starts on a turn of its own (#5530). Checks `signal`
	 * before each batch and rejects with its reason.
	 */
	async completeIndex(options: SnapshotIndexOptions = {}): Promise<void> {
		const states = await this.installIndex(options.pace, true);
		for (const { source, backfilled } of states) {
			if (backfilled) continue;
			const reset =
				source.name === "session-entries"
					? await SqlSnapshotBlobStore.prepareSessionIndexReset(this.database)
					: undefined;
			for (let done = false; !done; ) {
				options.signal?.throwIfAborted();
				done = await this.backfillBatch(source, options, reset);
				await this.betweenBatches(options.pace);
			}
		}
		// Reclamation must not delay publication: released collectors see exactly the same install and backfill as
		// before, even when either version exits at a batch boundary. Only unreferenced physical rows remain here.
		for (const { retired } of states)
			for (const receipt of retired ?? []) {
				const { drainRetiredSessionIndex } = await import("./session-index-reset.js");
				for (;;) {
					await this.betweenBatches(options.pace);
					options.signal?.throwIfAborted();
					const done = await this.write(options.pace, async (tx) => {
						const finished = await drainRetiredSessionIndex(tx, this.tables, receipt);
						if (options.holder !== undefined) await this.renewClaim(tx, options.holder);
						return finished;
					});
					if (done) break;
				}
			}
	}

	/** Indexes the next rows of `source`, and resolves true once every row at or below its watermark is indexed. */
	private backfillBatch(
		source: IndexSource,
		{ holder, pace, signal }: SnapshotIndexOptions,
		reset?: SessionIndexReset,
	): Promise<boolean> {
		const t = this.tables;
		const row = this.dialect.rowOrder();
		const withholds = withholdsVersion(this.dialect, source);
		return this.write(pace, async (transaction) => {
			const [state] = await readSourceStates(transaction, this.dialect, t, [source]);
			if (state === undefined || state.backfilled) return true;
			if (state.foreign) {
				// A build before 0.9.88 installed its own triggers since the loop read the states: the source is installed again
				// in this transaction, its old rows removed, as at the start of a collection. Left as it is, that build could
				// index it its way, and builds 0.9.88 and 0.9.89 trust their version row (#5558).
				await withShortSchemaLockWaits(transaction, this.dialect, () =>
					installSource(transaction, this.dialect, t, source, reset),
				);
				if (holder !== undefined) await this.renewClaim(transaction, holder);
				return false;
			}
			// A source that lost triggers meanwhile is indexed on, as its rows still need this build's statements; the sweep
			// installs its triggers again before it deletes anything.
			const progress = await transaction.get<SqliteRow & { watermark: number; backfilled_through: number }>(
				`SELECT watermark, backfilled_through FROM ${t.sources} WHERE source = ?`,
				source.name,
			);
			if (progress === undefined || progress.watermark < 0) return true;
			if (state.takeover) {
				// Installed by a build of 0.9.88 or 0.9.89 whose backfill is not done, which a build before 0.9.88 may have
				// indexed some of its way: this build indexes it again from its first row, with its own triggers, whose
				// pending trigger moves its own progress back, and holds the version row back until it is done, so that
				// builds 0.9.88 and 0.9.89 do not trust it meanwhile (#5558).
				await transaction.run(
					`INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, ?, 0) ${REPLACE_PROGRESS}`,
					source.own!,
					progress.watermark,
				);
				for (const name of [source.version!, rebuildRow(source)])
					await transaction.run(`DELETE FROM ${t.sources} WHERE source = ?`, name);
				for (const trigger of source.triggers)
					await transaction.exec(this.dialect.dropTrigger(trigger.name, trigger.table));
				await transaction.exec(source.triggers.map((trigger) => this.dialect.renderTrigger(trigger)).join("\n"));
			}
			// This build's own progress (#5558): rows an older build indexed past it are indexed again. On Postgres, which
			// no build before 0.9.88 opens, a source a build of 0.9.88 or 0.9.89 installed has none: its backfill, which
			// indexes what this one does, is trusted as far as it got.
			let own =
				source.own === undefined
					? undefined
					: await transaction.get<SqliteRow & { backfilled_through: number }>(
							`SELECT backfilled_through FROM ${t.sources} WHERE source = ?`,
							source.own,
						);
			if (source.own !== undefined && own === undefined && progress.backfilled_through < progress.watermark) {
				await transaction.run(
					`INSERT INTO ${t.sources} (source, watermark, backfilled_through) VALUES (?, ?, ?) ${REPLACE_PROGRESS}`,
					source.own,
					progress.watermark,
					progress.backfilled_through,
				);
				own = { backfilled_through: progress.backfilled_through };
			}
			const from =
				own !== undefined && own.backfilled_through < progress.backfilled_through
					? own.backfilled_through
					: progress.backfilled_through;
			// The version row says the index is this build's and complete: never while a trigger is missing, which a build
			// before 0.9.88 would install again its way under it (#5558).
			const publish = withholds && state.installed;
			if (from >= progress.watermark) {
				if (publish) await statementBatch(transaction, [publishVersion(t, source)], []);
				return true;
			}
			const { upper: lastRow } = (await transaction.get<SqliteRow & { upper: number | null }>(
				`SELECT MAX(${row}) AS upper FROM (SELECT ${row} FROM ${source.table} WHERE ${row} > ? AND ${row} <= ? ORDER BY ${row} LIMIT ?)`,
				from,
				progress.watermark,
				SNAPSHOT_INDEX_BACKFILL_BATCH,
			))!;
			const upper = lastRow ?? progress.watermark;
			for (const sql of source.backfill) await transaction.run(sql, from, upper);
			if (source.rowwise !== undefined) {
				const rows = await transaction.all<SqliteRow & { id: number }>(
					`SELECT ${row} AS id FROM ${source.table} WHERE ${row} > ? AND ${row} <= ? ORDER BY ${row}`,
					from,
					upper,
				);
				for (const { id } of rows) {
					// Stopping between rows rolls the whole batch back, progress included, so the pass stays resumable.
					signal?.throwIfAborted();
					for (const sql of source.rowwise) await transaction.run(sql, id);
				}
			}
			// Indexing rows again behind the source's progress, for this build's own, never moves the progress back.
			await transaction.run(
				`UPDATE ${t.sources} SET backfilled_through = ? WHERE source = ? AND backfilled_through < ?`,
				upper,
				source.name,
				upper,
			);
			if (own !== undefined)
				await transaction.run(
					`UPDATE ${t.sources} SET watermark = ?, backfilled_through = ? WHERE source = ?`,
					progress.watermark,
					upper,
					source.own!,
				);
			if (holder !== undefined) await this.renewClaim(transaction, holder);
			const done = upper >= progress.watermark;
			// Both progress rows reach the watermark: builds 0.9.88 and 0.9.89 may trust the index now (#5558).
			if (done && publish) await statementBatch(transaction, [publishVersion(t, source)], []);
			return done;
		});
	}

	/**
	 * Deletes every blob stored or re-stored at least `graceSeconds` ago on the database clock that no retained snapshot
	 * and no snapshot dispatched work carries references, and resolves with the hashes deleted. Reads the reference index
	 * and the blob table's age index, never a journal or a session. Ages are counted in whole seconds, so a blob can stay
	 * up to a second past `graceSeconds`, never less.
	 *
	 * Pages through the aged blobs, oldest first, {@link SNAPSHOT_COLLECTION_BATCH} at a time, and keeps as candidates
	 * those no retaining run, no carried work and no session retains. A session's retained snapshots are found by walking
	 * its snapshot entries, at most {@link SNAPSHOT_COLLECTION_SESSION_REFS} of them per statement, once per sweep
	 * (#5530). The candidates are deleted in batches, each one write transaction that finds the retained snapshots of the
	 * sessions it walked for its blobs again, in one statement, and deletes only the blobs none of them retains, no other
	 * session records, and that are still old and unreferenced by runs and carried work. So a reference published before
	 * the batch commits keeps its blob, and a process killed mid-collection leaves only garbage. The event loop never
	 * gets a turn inside a write transaction: another connection of this process that wrote then would wait for the
	 * write lock while holding the event loop, and the transaction could not end until it gave up.
	 *
	 * Every batch first checks, in its transaction, that every referencing table has its triggers and a finished
	 * backfill, as {@link completeIndex} leaves them. When one does not, because a table appeared or lost its triggers
	 * since, nothing is deleted until the index has been completed again. A sweep repairs the index once; when it is
	 * incomplete again after that, because the schema keeps changing under it, the sweep stops without deleting
	 * anything more and the next collection tries again. Gives the event loop a turn between statements that walk
	 * sessions, between batches and between pages, and checks `signal` before each and rejects with its reason.
	 */
	async sweep(options: SnapshotSweepOptions): Promise<readonly string[]> {
		const t = this.tables;
		options.signal?.throwIfAborted();
		const trigger = `${t.blobs}_chunks_delete_all`;
		const required = [trigger, `${t.blobs}_age`, `${t.blobs}_inline_size`];
		// Asked with them: whether forks share their parents' histories, whose inherited snapshots the sweep keeps (#6560).
		const schema = this.dialect.schemaObjects([...required, this.forkSegments]);
		const present = new Set(
			(await this.database.all<SqliteRow & { name: string }>(schema.sql, ...schema.params)).map((row) => row.name),
		);
		const forks = present.has(this.forkSegments);
		if (!required.every((name) => present.has(name))) {
			options.signal?.throwIfAborted();
			await this.write(options.pace, async (transaction) => {
				if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
				await withShortSchemaLockWaits(transaction, this.dialect, async () => {
					if (!present.has(trigger)) await addBlobChunks(transaction, t, this.dialect);
					await addBlobMaintenanceIndexes(transaction, t);
				});
			});
			await this.betweenBatches(options.pace);
		}
		const minimumAge = collectableAge(options.graceSeconds);
		const deleted: string[] = [];
		const turns = new SweepTurns(options, () => this.betweenBatches(options.pace));
		let sessions = new SweepSessions();
		let cursor: PageRow | undefined;
		let repaired = false;
		let renewedAt = Number.NEGATIVE_INFINITY;
		for (;;) {
			await turns.next();
			if (options.holder !== undefined && performance.now() - renewedAt >= SWEEP_CLAIM_RENEWAL_MS) {
				// Pages that hold nothing to delete write nothing else; the claim is renewed when the sweep starts and then
				// at least once per quarter lease.
				const holder = options.holder;
				await this.write(options.pace, (transaction) => this.renewClaim(transaction, holder));
				renewedAt = performance.now();
			}
			const page = await this.page(minimumAge, cursor);
			const candidates = await this.unretainedOf(
				page.map((row) => row.hash),
				sessions,
				turns,
				forks,
			);
			let incomplete = false;
			for (const batch of sessions.batches(candidates)) {
				// Every delete batch starts on a turn of its own and ends with one: never a turn while it holds the write lock.
				await turns.next();
				const removed = await this.deleteUnretained(batch, minimumAge, options);
				turns.held();
				if (removed === undefined) {
					incomplete = true;
					break;
				}
				renewedAt = performance.now();
				deleted.push(...removed);
				options.onBatch?.(removed);
			}
			if (incomplete) {
				if (repaired) return deleted;
				repaired = true;
				await this.completeIndex(options);
				sessions = new SweepSessions();
				continue;
			}
			if (page.length < SNAPSHOT_COLLECTION_BATCH) {
				await this.stampLegacyAges(options);
				await this.moveChunksToRowTable(options);
				return deleted;
			}
			cursor = page.at(-1);
			// Every page holds the event loop, also one whose blobs runs, carried work or sessions this sweep walked
			// already retain, which walks no session and deletes nothing: the next page starts after a turn (#5530).
			turns.held();
		}
	}

	/**
	 * Which of `hashes` no retaining run, no carried work and no session retains, as far as these reads see: the sweep's
	 * candidates, which a delete batch checks again in its transaction. Finds the retained blobs of each session that
	 * references one of them and that `sessions` has not walked yet, in statements of at most
	 * {@link SNAPSHOT_COLLECTION_SESSION_REFS} snapshot entries, with a turn between them.
	 */
	private async unretainedOf(
		hashes: readonly string[],
		sessions: SweepSessions,
		turns: SweepTurns,
		forks: boolean,
	): Promise<SweepCandidate[]> {
		if (hashes.length === 0) return [];
		const t = this.tables;
		const free = await this.database.all<SqliteRow & { hash: string }>(
			`SELECT value AS hash FROM ${this.dialect.jsonValues("?")} WHERE ${this.unreferencedByRuns("value")}`,
			JSON.stringify(hashes),
		);
		if (free.length === 0) return [];
		const referencing = new Map<string, string[]>(free.map((row) => [row.hash, []]));
		for (const { hash, session_id } of await this.database.all<SqliteRow & { hash: string; session_id: string }>(
			`SELECT DISTINCT hash, session_id FROM ${t.sessionRecords} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")})`,
			JSON.stringify([...referencing.keys()]),
		))
			referencing.get(hash)?.push(session_id);
		const unwalked = sessions.unwalked([...referencing.values()].flat());
		if (unwalked.length > 0) {
			const costs = await this.sessionCosts(unwalked, () => turns.light());
			sessions.cost(costs);
			for (const group of sessionGroups(costs)) {
				await turns.next();
				sessions.retain(group, await this.retainedBySessions(group, forks));
				turns.held();
			}
		}
		return [...referencing]
			.filter(([hash]) => !sessions.retains(hash))
			.map(([hash, referencedBy]) => ({ hash, sessions: referencedBy }));
	}

	/**
	 * Deletes the blobs of `batch` that are still old and that no retaining run, no carried work and no session retains,
	 * in one write transaction, and resolves with the hashes deleted; undefined, deleting nothing, when the reference
	 * index is incomplete. The transaction checks the batch's blobs again in one statement, so what it sees is what
	 * holds when the batch commits: the snapshots the batch's sessions, those the sweep walked for its blobs, retain now,
	 * and the sessions that record its blobs now. A blob a session the sweep did not walk records, such as one created
	 * since, is kept; the next collection walks that session. Nothing in the transaction waits for a turn of the event
	 * loop (#5530).
	 */
	private deleteUnretained(
		batch: SweepDeleteBatch,
		minimumAge: number,
		options: SnapshotSweepOptions,
	): Promise<string[] | undefined> {
		const t = this.tables;
		return this.write(options.pace, async (transaction) => {
			const found = new Set<string>();
			const states = await readSourceStates(transaction, this.dialect, this.tables, this.sources, false, undefined, {
				names: [this.forkSegments],
				found,
			});
			if (!states.every((state) => state.installed && state.backfilled)) return undefined;
			if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
			const kept = new Set(await this.keptBySessions(transaction, batch, found.has(this.forkSegments)));
			const unretained = batch.hashes.filter((hash) => !kept.has(hash));
			if (unretained.length === 0) return [];
			const rows = await transaction.all<SqliteRow & { hash: string }>(
				`DELETE FROM ${t.blobs} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND created_at > 0 AND created_at <= ${this.dialect.nowSeconds} - ? AND ${this.unreferencedByRuns(`${t.blobs}.hash`)} RETURNING hash`,
				JSON.stringify(unretained),
				minimumAge,
			);
			return rows.map((row) => row.hash);
		});
	}

	/** A condition that no retaining run and no carried work references the blob `hash` names. */
	private unreferencedByRuns(hash: string): string {
		const t = this.tables;
		return `NOT EXISTS (
				SELECT 1 FROM ${t.runRefs} AS ref WHERE ref.hash = ${hash}
				AND NOT EXISTS (SELECT 1 FROM ${t.runState} AS state WHERE state.run_id = ref.run_id AND state.retained = 0)
			) AND NOT EXISTS (SELECT 1 FROM ${t.carriedRefs} AS carried WHERE carried.hash = ${hash})`;
	}

	/**
	 * How many snapshot entries finding the retained snapshots of each of `sessions` walks: the entries of the session,
	 * once for each distinct latest snapshot entry of its open leaves, which bounds the entries on those leaves'
	 * branches. Reads one session per statement, waiting for `turn` between statements.
	 */
	private async sessionCosts(sessions: readonly string[], turn: () => Promise<void>): Promise<Map<string, number>> {
		const t = this.tables;
		const costs = new Map<string, number>();
		for (const [index, session] of sessions.entries()) {
			if (index > 0) await turn();
			const row = await this.database.get<SqliteRow & { refs: number; anchors: number }>(
				`SELECT count(*) AS refs,
					(SELECT count(DISTINCT anchor_seq) FROM ${t.sessionLinks} WHERE session_id = ? AND children = 0 AND anchor_seq IS NOT NULL) AS anchors
				FROM ${t.sessionRefs} WHERE session_id = ?`,
				session,
				session,
			);
			costs.set(session, Math.max(1, Number(row?.refs ?? 0) * Number(row?.anchors ?? 0)));
		}
		return costs;
	}

	/**
	 * The blobs that the snapshots `sessions` retain reference, in one statement. A session whose tree the index could
	 * not follow retains every snapshot it records.
	 */
	private async retainedBySessions(sessions: readonly string[], forks: boolean): Promise<string[]> {
		const t = this.tables;
		const ids = JSON.stringify(sessions);
		const inherited = this.inheritedRecord(forks);
		const rows = await this.database.all<SqliteRow & { hash: string }>(
			`SELECT DISTINCT record.hash FROM ${t.sessionRecords} AS record
			WHERE record.session_id IN (SELECT value FROM ${this.dialect.jsonValues("?")})
			AND (
				(record.session_id, record.snapshot_id) IN (${this.sessionHeads(`session_id IN (SELECT value FROM ${this.dialect.jsonValues("?")})`)})
				OR EXISTS (SELECT 1 FROM ${t.sessionLinks} AS broken WHERE broken.session_id = record.session_id AND broken.broken = 1)${inherited}
			)`,
			ids,
			ids,
		);
		return rows.map((row) => row.hash);
	}

	/**
	 * A condition, after `OR`, that another session inherits the session record `record` through a fork segment
	 * (#6560); empty when `forks` says the fork segments table is not there, as while shared-history forks are off. A
	 * fork that shares its parent's history stores none of the entries it inherits, so its own references never name
	 * their snapshots: a record a segment names is kept whatever its session retains, as long as the segment lasts. A
	 * delete batch reads whether the table exists in its own transaction, so it sees the segments that hold when it
	 * commits.
	 */
	private inheritedRecord(forks: boolean): string {
		if (!forks) return "";
		return `
				OR EXISTS (SELECT 1 FROM ${this.forkSegments} AS segment WHERE segment.source_id = record.session_id AND record.seq BETWEEN segment.from_seq AND segment.to_seq)`;
	}

	/**
	 * The blobs of `batch` that a session records and that the delete must keep, in one statement: those the snapshots
	 * of `batch.sessions` retain, and those a session not among them records, whose snapshots the sweep did not walk.
	 * Walks only `batch.sessions`, whose snapshot entries the sweep bounded when it made the batch (#5530).
	 */
	private async keptBySessions(executor: SqliteExecutor, batch: SweepDeleteBatch, forks: boolean): Promise<string[]> {
		const t = this.tables;
		const ids = JSON.stringify(batch.sessions);
		const walked = `(SELECT value FROM ${this.dialect.jsonValues("?")})`;
		const inherited = this.inheritedRecord(forks);
		const rows = await executor.all<SqliteRow & { hash: string }>(
			`SELECT DISTINCT record.hash FROM ${t.sessionRecords} AS record
			WHERE record.hash IN (SELECT value FROM ${this.dialect.jsonValues("?")})
			AND (
				record.session_id NOT IN ${walked}
				OR (record.session_id, record.snapshot_id) IN (${this.sessionHeads(`session_id IN ${walked}`)})
				OR EXISTS (SELECT 1 FROM ${t.sessionLinks} AS broken WHERE broken.session_id = record.session_id AND broken.broken = 1)${inherited}
			)`,
			JSON.stringify(batch.hashes),
			ids,
			ids,
		);
		return rows.map((row) => row.hash);
	}

	/**
	 * Stamps every blob of unknown age with the database clock, in hash order, in write transactions of at most
	 * {@link SNAPSHOT_LEGACY_STAMP_BYTES} of blobs. Moves every in-row blob larger than
	 * {@link SNAPSHOT_BLOB_CHUNK_BYTES} to chunks regardless of age. Chunk writes have the same byte bound;
	 * publishing also frees the old in-row value, whose cost grows with its size. Starts with a turn of the event loop
	 * when there is anything to do, so its first write does not share the turn of the sweep's last batch, and every
	 * stamp and every statement of a move ends with a turn, whatever it found, so every page does too (#5530).
	 */
	private async stampLegacyAges(options: SnapshotIndexOptions): Promise<void> {
		const oversized = `chunks = 0 AND length(data) > ${SNAPSHOT_BLOB_CHUNK_BYTES}`;
		if (
			!(await this.database.get(
				`SELECT 1 FROM ${this.table} WHERE created_at = 0 UNION ALL SELECT 1 FROM ${this.table} WHERE ${oversized} LIMIT 1`,
			))
		)
			return;
		await this.betweenBatches(options.pace);
		let after = "";
		for (;;) {
			options.signal?.throwIfAborted();
			const page = await this.database.all<SqliteRow & { hash: string; size: number }>(
				`SELECT hash, length(data) AS size FROM ${this.table} WHERE created_at = 0 AND hash > ? UNION ALL SELECT hash, length(data) AS size FROM ${this.table} WHERE ${oversized} AND created_at > 0 AND hash > ? ORDER BY hash LIMIT ?`,
				after,
				after,
				SNAPSHOT_COLLECTION_BATCH,
			);
			let batch: string[] = [];
			let bytes = 0;
			for (const { hash, size } of page) {
				const oversized = Number(size) > SNAPSHOT_BLOB_CHUNK_BYTES;
				if (batch.length > 0 && (oversized || bytes + Number(size) > SNAPSHOT_LEGACY_STAMP_BYTES)) {
					await this.stampInRows(batch, options);
					batch = [];
					bytes = 0;
				}
				if (oversized) {
					await this.moveLegacyBlobToChunks(hash, options);
				} else {
					batch.push(hash);
					bytes += Number(size);
				}
			}
			if (batch.length > 0) await this.stampInRows(batch, options);
			if (page.length < SNAPSHOT_COLLECTION_BATCH) return;
			after = page.at(-1)!.hash;
		}
	}

	/** Stamps the blobs `hashes` name that still have an unknown age, in their rows, in one write transaction. */
	private async stampInRows(hashes: readonly string[], options: SnapshotIndexOptions): Promise<void> {
		options.signal?.throwIfAborted();
		await this.write(options.pace, async (transaction) => {
			if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
			await transaction.run(
				`UPDATE ${this.table} SET created_at = ${this.dialect.nowSeconds} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND created_at = 0`,
				JSON.stringify(hashes),
			);
		});
		await this.betweenBatches(options.pace);
	}

	/**
	 * Moves an in-row legacy blob to chunks regardless of age. Reads its bytes without the writer and writes at most
	 * {@link SNAPSHOT_LEGACY_STAMP_BYTES} per transaction while readers retain the in-row value. Publishing stamps
	 * only an unknown age and frees the old value under the writer, with time proportional to the freed size. A stopped
	 * move leaves chunks the next move reuses.
	 * Gives the event loop a turn after reading the blob's bytes and after every transaction, also when another host
	 * moved or deleted the blob first (#5530).
	 */
	private async moveLegacyBlobToChunks(hash: string, options: SnapshotIndexOptions): Promise<void> {
		const t = this.tables;
		const unmoved = `hash = ? AND chunks = 0 AND length(data) > ${SNAPSHOT_BLOB_CHUNK_BYTES}`;
		const legacy = await this.database.get<SqliteRow & { data: Uint8Array }>(
			`SELECT data FROM ${t.blobs} WHERE ${unmoved}`,
			hash,
		);
		await this.betweenBatches(options.pace);
		if (legacy === undefined) return;
		const { data } = legacy;
		const chunks = Math.ceil(data.byteLength / SNAPSHOT_BLOB_CHUNK_BYTES);
		const perTransaction = SNAPSHOT_LEGACY_STAMP_BYTES / SNAPSHOT_BLOB_CHUNK_BYTES;
		for (let first = 0; first < chunks; first += perTransaction) {
			options.signal?.throwIfAborted();
			const pending = await this.write(options.pace, async (transaction) => {
				if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
				if (!(await transaction.get(`SELECT 1 FROM ${t.blobs} WHERE ${unmoved}`, hash))) {
					await this.dropStrayChunks(transaction, [hash]);
					return false;
				}
				for (let index = first; index < Math.min(first + perTransaction, chunks); index++) {
					await transaction.run(
						`INSERT INTO ${t.blobChunks} (hash, idx, data) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
						hash,
						index,
						data.subarray(index * SNAPSHOT_BLOB_CHUNK_BYTES, (index + 1) * SNAPSHOT_BLOB_CHUNK_BYTES),
					);
				}
				return true;
			});
			await this.betweenBatches(options.pace);
			if (!pending) return;
		}
		options.signal?.throwIfAborted();
		await this.write(options.pace, async (transaction) => {
			if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
			const { changes } = await transaction.run(
				`UPDATE ${t.blobs} SET data = ?, chunks = ?, created_at = CASE WHEN created_at = 0 THEN ${this.dialect.nowSeconds} ELSE created_at END WHERE ${unmoved} AND (SELECT count(*) FROM ${t.blobChunks} WHERE hash = ?) = ?`,
				new Uint8Array(),
				chunks,
				hash,
				hash,
				chunks,
			);
			if (changes === 0) await this.dropStrayChunks(transaction, [hash]);
		});
		await this.betweenBatches(options.pace);
	}

	/**
	 * Deletes the chunks of the blobs `hashes` names whose rows hold their bytes themselves or are gone: chunks that a
	 * move wrote before another writer deleted or replaced its row. Completed chunked blobs retain their chunks.
	 */
	private async dropStrayChunks(transaction: SqliteExecutor, hashes: readonly string[]): Promise<void> {
		const t = this.tables;
		await transaction.run(
			`DELETE FROM ${t.blobChunks} WHERE hash IN (SELECT value FROM ${this.dialect.jsonValues("?")}) AND NOT EXISTS (SELECT 1 FROM ${t.blobs} AS stored WHERE stored.hash = ${t.blobChunks}.hash AND stored.chunks > 0)`,
			JSON.stringify(hashes),
		);
	}

	/**
	 * Moves a chunk table that an earlier release created `WITHOUT ROWID` to the row layout of
	 * {@link chunkTableDefinition} (#5541), in write transactions that each copy or free at most
	 * {@link SNAPSHOT_CHUNK_MOVE_ROWS} chunks in all. It copies the rows, in key order, to a new table in that layout;
	 * later transactions copy the rows written since and drop the copies of rows deleted since, and the one that leaves
	 * the new table holding exactly the chunk table's rows gives it the chunk table's name, under which the old one is
	 * kept until later transactions empty and drop it. The chunk table keeps its name, columns and key throughout, so
	 * a process of an earlier release reads and writes it unchanged, and a chunk is copied with its bytes: its key, a
	 * blob's hash and an index, names them. A stopped move resumes from what the tables hold. Does nothing on a chunk
	 * table in the row layout, which every Postgres table is.
	 */
	private async moveChunksToRowTable(options: SnapshotSweepOptions, offline = false): Promise<void> {
		const t = this.tables;
		const { next, retired } = chunkMoveTables(t);
		// The old table is `WITHOUT ROWID` under either name, so one statement tells a store with nothing to move, as
		// every store is once its move is over.
		const probe = this.dialect.withoutRowidTables([t.blobChunks, retired]);
		const clustered = async (executor: SqliteExecutor) =>
			(await executor.all<SqliteRow & { name: string }>(probe.sql, ...probe.params)).map((row) => row.name);
		const rows = SNAPSHOT_CHUNK_MOVE_ROWS;
		const pending = await clustered(this.database);
		if (pending.includes(retired)) await this.dropChunkTable(retired, options, offline);
		if (!pending.includes(t.blobChunks)) return;
		// A copy the disk has no room for would fill it (#5694): the table stays as it is, read and written as before, and a
		// partial copy an earlier collection left is dropped, its pages back on the database's free list.
		const pendingMove = await this.chunkCopySpace(next, offline);
		if (pendingMove) {
			if (offline)
				throw new Error(
					pendingMove.reason === "free-space"
						? `The chunk move needs ${pendingMove.requiredFreeBytes} free bytes; ${pendingMove.freeBytes} are available.`
						: "Cannot measure free disk space for the offline chunk move.",
				);
			options.onPendingChunkMove?.(pendingMove);
			return this.dropChunkTable(next, options);
		}
		// Copies the rows after the last one copied: no other statement writes the new table before it is renamed.
		const copyNext = async (transaction: SqliteExecutor) => {
			const last = await transaction.get<SqliteRow & { hash: string; idx: number }>(
				`SELECT hash, idx FROM ${next} ORDER BY hash DESC, idx DESC LIMIT 1`,
			);
			const { changes } = await transaction.run(
				`INSERT INTO ${next} (hash, idx, data) SELECT hash, idx, data FROM ${t.blobChunks} WHERE (hash, idx) > (?, ?) ORDER BY hash, idx LIMIT ? ON CONFLICT DO NOTHING`,
				last?.hash ?? "",
				last?.idx ?? -1,
				rows,
			);
			return changes;
		};
		// Copies the first rows the new table lacks, wherever they are: rows written behind the copy.
		const copyMissing = async (transaction: SqliteExecutor) => {
			const { changes } = await transaction.run(
				`INSERT INTO ${next} (hash, idx, data) SELECT old.hash, old.idx, old.data FROM ${t.blobChunks} AS old WHERE NOT EXISTS (SELECT 1 FROM ${next} AS copy WHERE copy.hash = old.hash AND copy.idx = old.idx) ORDER BY old.hash, old.idx LIMIT ?`,
				rows,
			);
			return changes;
		};
		// The rows the new table holds and the chunk table no longer does: copies of rows deleted since they were copied.
		const stale = `SELECT hash, idx FROM ${next} EXCEPT SELECT hash, idx FROM ${t.blobChunks}`;
		for (let copying = true; ; ) {
			options.signal?.throwIfAborted();
			if (offline) await this.requireOfflineBatchSpace();
			let moved: boolean;
			try {
				moved = await this.write(options.pace, async (transaction) => {
					if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
					if (!(await clustered(transaction)).includes(t.blobChunks)) return true;
					await transaction.exec(chunkTableDefinition(next, this.dialect));
					if (copying) {
						copying = (await copyNext(transaction)) === rows;
						return false;
					}
					// Rows copied and stale copies dropped share the transaction's rows. The tables are renamed only by a transaction
					// that leaves the new table holding exactly the chunk table's rows; otherwise the next transaction continues.
					const copied = await copyMissing(transaction);
					if (copied === rows) return false;
					const room = rows - copied;
					const { changes: dropped } = await transaction.run(
						`DELETE FROM ${next} WHERE (hash, idx) IN (${stale} LIMIT ?)`,
						room,
					);
					if (dropped === room && (await transaction.get(`${stale} LIMIT 1`)) !== undefined) return false;
					// Renaming the table would point a trigger that names it at the old table: both of the delete triggers releases
					// installed are dropped, and the current one is installed again on the new table.
					await transaction.exec(this.dialect.dropTrigger(`${t.blobs}_chunks_delete`, t.blobs));
					await transaction.exec(this.dialect.dropTrigger(`${t.blobs}_chunks_delete_all`, t.blobs));
					try {
						await transaction.exec(`ALTER TABLE ${t.blobChunks} RENAME TO ${retired}`);
						await transaction.exec(`ALTER TABLE ${next} RENAME TO ${t.blobChunks}`);
					} catch (error) {
						await this.confirmRenameBlocker(transaction, error);
						throw error;
					}
					await transaction.exec(this.dialect.renderTrigger(chunksDeleteTrigger(t)));
					return true;
				});
			} catch (error) {
				// A disk that fills up ends the move, not the collection (#5694): the partial copy is dropped, its pages back on
				// the database's free list, and a later collection tries again.
				if (offline || !isStorageSpaceFailure(error)) throw error;
				await this.betweenBatches(options.pace);
				return this.dropChunkTable(next, options);
			}
			if (offline) await this.checkpointChunkMove();
			await this.betweenBatches(options.pace);
			if (moved) break;
		}
		await this.dropChunkTable(retired, options, offline);
	}

	/**
	 * Records on `error`, a rename that failed in `transaction`, the trigger or view SQLite named in it, when the schema
	 * holds exactly one trigger or view that the error's words can name (#5622). The failed statement left the
	 * transaction open on the schema SQLite checked, so that object is the one SQLite named. Otherwise, or when the schema
	 * cannot be read, nothing is recorded and the collection warning names no object.
	 */
	private async confirmRenameBlocker(transaction: SqliteExecutor, error: unknown): Promise<void> {
		const candidates = renameBlockerCandidates(error);
		if (candidates.length === 0) return;
		const names = JSON.stringify([...new Set(candidates.map((candidate) => candidate.name))]);
		const objects = (schema: string) =>
			`SELECT type, name FROM ${schema} WHERE type IN ('trigger', 'view') AND name IN (SELECT value FROM ${this.dialect.jsonValues("?")})`;
		const rows = await transaction
			.all<SqliteRow & SchemaObject>(
				`${objects("sqlite_master")} UNION ALL ${objects("sqlite_temp_master")}`,
				names,
				names,
			)
			.catch(() => undefined);
		if (rows === undefined) return;
		const named = rows.filter((row) =>
			candidates.some((candidate) => candidate.type === row.type && candidate.name === row.name),
		);
		const [only] = named;
		if (named.length === 1 && only !== undefined && typeof error === "object" && error !== null)
			Reflect.defineProperty(error, RENAME_BLOCKER, { value: { type: only.type, name: only.name } });
	}

	/**
	 * Whether the file system of a SQLite database file has room to copy what is left of the chunk table to the
	 * row layout (#5694): the copy grows the file by the bytes its free pages do not hold, and the write-ahead log can
	 * hold every page the copy writes until a checkpoint moves them into the file, with
	 * {@link SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES} left over; the database's own `freeBytes` says how much the file system
	 * holds. A database whose disk this process cannot see, such as a libSQL server, moves only what is left of a table
	 * no larger than that headroom: the move must never be what fills a disk, and the old layout works as before.
	 */
	private async chunkCopySpace(next: string, offline: boolean): Promise<PendingChunkMove | undefined> {
		const rowsOf = async (table: string) =>
			Number(
				(await this.database.get<SqliteRow & { rows: number }>(`SELECT count(*) AS rows FROM ${table}`))?.rows ?? 0,
			);
		const copy = this.dialect.tableExists(next);
		const copyExists = async () => (await this.database.get(copy.sql, ...copy.params)) !== undefined;
		// The chunks the copy lacks, counted in one statement against what it holds: a copy may also hold copies of chunks
		// deleted since, which take no more room, and chunks stored since that it lacks.
		const lacking = async () =>
			Number(
				(
					await this.database.get<SqliteRow & { rows: number }>(
						`SELECT count(*) AS rows FROM ${this.tables.blobChunks} AS old WHERE NOT EXISTS (SELECT 1 FROM ${next} AS copy WHERE copy.hash = old.hash AND copy.idx = old.idx)`,
					)
				)?.rows ?? 0,
			);
		const rows = !(await copyExists())
			? await rowsOf(this.tables.blobChunks)
			: await lacking().catch(async (error: unknown) => {
					// Another collector finished the move, which took the copy's name, or dropped the copy, since it was found:
					// none of it is left to count on. The move's own transactions see which.
					if (!(await copyExists())) return rowsOf(this.tables.blobChunks);
					throw error;
				});
		const left = rows * SNAPSHOT_BLOB_CHUNK_BYTES;
		let free: number | undefined;
		try {
			free = await this.database.freeBytes?.();
		} catch {
			// A reading that fails is no reading: the collection goes on as for a disk this process cannot see.
			free = undefined;
		}
		if (free === undefined)
			return !offline && left <= SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES
				? undefined
				: {
						reason: "space-unknown",
						remainingBytes: left,
						automaticLimitBytes: SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES,
					};
		const freePages = await this.database.get<SqliteRow & { bytes: number }>(
			"SELECT (SELECT freelist_count FROM pragma_freelist_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes",
		);
		const reused = Math.min(left, Number(freePages?.bytes ?? 0));
		const requiredFreeBytes =
			left - reused + (offline ? OFFLINE_CHUNK_LOG_ALLOWANCE : left) + SNAPSHOT_CHUNK_MOVE_HEADROOM_BYTES;
		return free >= requiredFreeBytes
			? undefined
			: { reason: "free-space", remainingBytes: left, requiredFreeBytes, freeBytes: free };
	}

	/**
	 * Empties `table`, the chunk table a move to the row layout retired or a partial copy of the move (#5694), in write
	 * transactions of at most {@link SNAPSHOT_CHUNK_MOVE_ROWS} rows, from its first key on, then drops it; its pages go
	 * to the database's free list. A full disk stops it without a failure: a later collection goes on.
	 */
	private async dropChunkTable(table: string, options: SnapshotIndexOptions, offline = false): Promise<void> {
		const probe = this.dialect.tableExists(table);
		if ((await this.database.get(probe.sql, ...probe.params)) === undefined) return;
		for (;;) {
			options.signal?.throwIfAborted();
			if (offline) await this.requireOfflineBatchSpace();
			let dropped: boolean;
			try {
				dropped = await this.write(options.pace, async (transaction) => {
					if (options.holder !== undefined) await this.renewClaim(transaction, options.holder);
					if ((await transaction.get(probe.sql, ...probe.params)) === undefined) return true;
					const last = await transaction.get<SqliteRow & { hash: string; idx: number }>(
						`SELECT hash, idx FROM ${table} ORDER BY hash, idx LIMIT 1 OFFSET ?`,
						SNAPSHOT_CHUNK_MOVE_ROWS - 1,
					);
					if (last === undefined) {
						await transaction.exec(`DROP TABLE IF EXISTS ${table}`);
						return true;
					}
					await transaction.run(`DELETE FROM ${table} WHERE (hash, idx) <= (?, ?)`, last.hash, last.idx);
					return false;
				});
			} catch (error) {
				if (!offline && isStorageSpaceFailure(error)) return;
				throw error;
			}
			if (offline) await this.checkpointChunkMove();
			await this.betweenBatches(options.pace);
			if (dropped) return;
		}
	}

	/** {@link completeIndex}, then {@link sweep}: what a manual collection does. */
	async collectGarbage(options: SnapshotSweepOptions): Promise<readonly string[]> {
		await this.completeIndex(options);
		return this.sweep(options);
	}

	/**
	 * The snapshots the sessions that `sessions` selects keep, a condition on `session_id` (#5530), as a subquery of
	 * `(session_id, snapshot_id)`: for every leaf of their session trees,
	 * the latest snapshot entry of each checkout on the leaf's branch, followed through each entry's link to the
	 * nearest snapshot entry before it. A leaf costs the snapshot entries on its branch and never a message, and leaves
	 * that share their latest snapshot are followed once. Roots are grouped into checkouts the way resume does: a root
	 * a restore moved to is the root it moved from, taking the branch's restores from the newest back. Resume compares
	 * canonical paths where this compares the recorded ones, so a checkout reached through a symbolic link can keep one
	 * snapshot more than resume needs and never fewer. A head that records a partly restored worktree also keeps the
	 * snapshot it lacks, named in `degraded_from`, for {@link DEGRADED_RESTORE_RETENTION_DAYS} (#4922).
	 */
	private sessionHeads(sessions: string): string {
		const t = this.tables;
		return `WITH RECURSIVE
			open_anchors(session_id, seq) AS (SELECT DISTINCT session_id, anchor_seq FROM ${t.sessionLinks} WHERE ${sessions} AND children = 0 AND anchor_seq IS NOT NULL),
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
	 * the database clock, oldest first, after `after`: a range of the age index, whatever references them. A page after
	 * `after` searches the index from `after`, which already excludes an unknown age (0): with `created_at > 0` as a
	 * second lower bound, SQLite searched from the oldest blob instead, so each page cost more than the one before (#5530).
	 */
	private page(minimumAge: number, after: PageRow | undefined): Promise<PageRow[]> {
		const t = this.tables;
		return after === undefined
			? this.database.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at > 0 AND created_at <= ${this.dialect.nowSeconds} - ? ORDER BY created_at, hash LIMIT ?`,
					minimumAge,
					SNAPSHOT_COLLECTION_BATCH,
				)
			: this.database.all<PageRow>(
					`SELECT created_at, hash FROM ${t.blobs} WHERE created_at <= ${this.dialect.nowSeconds} - ? AND (created_at, hash) > (?, ?) ORDER BY created_at, hash LIMIT ?`,
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
