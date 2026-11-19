import {
	type FencedPathId,
	POSTGRES_POOL_SESSION_PREFIX,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	type SqliteTransactionOptions,
	type SqlSnapshotBlobStore,
	type StorageDialect,
	type StorageNotificationSubscription,
	type StorageNotifications,
	type StoredJournalPayload,
	storedJournalPayload,
	storedJsonChunks,
} from "@bastani/atomic/storage";
import {
	type AppendOutcome,
	type JournalEntry,
	type Lease,
	RUN_EVENT_TYPES,
	type RunJournal,
	type RunJournalBatchAppend,
	type RunSnapshotTail,
	type RunVersion,
} from "./types.js";

export type { RunJournalBatchAppend as JournalBatchAppend, RunSnapshotTail, RunVersion } from "./types.js";

/** Methods known to accept cancellation. An adapter or decorator with the original signature keeps its original call. */
export const cancellableRunListings = new WeakSet<RunJournal["listRuns"]>();

export const JOURNAL_READ_PAGE_SIZE = 256;
/**
 * The most characters of event payload one journal read returns, by the payload's `length()`, so a page of large
 * checkpoints stays under a libSQL server's 10 MB response limit: a character is at most four bytes of UTF-8 (#4954).
 * A page ends with the event that takes it past this, so one event larger than this is a page of its own. Reading and
 * decoding a page holds the event loop with the local SQLite store, so a page is kept to a quarter of a megabyte:
 * a page of a megabyte took up to 100 ms when its pages were not cached (#5480).
 */
export const JOURNAL_READ_PAGE_CHARS = 256 * 1024;

/**
 * The rows the next statement of a paged read fetches, after one that fetched `fetched` rows of a batch of `limit`
 * and kept `kept` of them in its page. A statement measures every row of its batch to cut its page, so the batch
 * follows what the pages hold and a page costs about what it returns: it doubles, up to `max`, while whole batches
 * fit, and shrinks to twice what the page held when large rows ended it early (#4954, #4768).
 */
export function nextReadBatch(limit: number, fetched: number, kept: number, max: number): number {
	return kept >= fetched ? Math.min(max, limit * 2) : Math.max(1, Math.min(max, kept * 2));
}

/**
 * How every journal write transaction waits for the write lock: up to 10 minutes of no commit anywhere, far past the
 * 30 s a connection waits by default. A process stalled holding the lock (starved of CPU, paused for garbage
 * collection, stopped by a signal) commits or rolls back once it runs again, and failing the waiting write would only
 * fail its run without freeing the lock (#4183). Only waiting for the lock is longer: once a write has the lock it
 * checks its lease or work lease as before, so a stall longer than a lease ends in that lease's expiry and fencing,
 * never in a write applied under a lease that was lost meanwhile. Waiters keep their writers'-queue order only while
 * they keep polling; that order is fairness, not correctness, which the checks inside each transaction keep.
 */
export const JOURNAL_TRANSACTION: SqliteTransactionOptions = { lockWaitMs: 10 * 60_000 };

/**
 * A run journal's own write transaction: it waits for the write lock as {@link JOURNAL_TRANSACTION} does, and runs
 * again when a transient failure of a database server ended it before it committed, such as a libSQL server expiring
 * the stream of a process stopped mid-transaction (#4383). Its bodies use nothing but the transaction handle, a run
 * that ended this way wrote nothing to duplicate, and each run checks the lease again before it writes.
 */
export const JOURNAL_WRITE_TRANSACTION: SqliteTransactionOptions = {
	...JOURNAL_TRANSACTION,
	retryTransientFailures: true,
};

/** Event types the durable backend folds without replacing the run's handle; every other event carries it. */
export const NON_SNAPSHOT_EVENT_TYPES = [
	RUN_EVENT_TYPES.checkpointRecorded,
	RUN_EVENT_TYPES.messageSettled,
	RUN_EVENT_TYPES.messageDelivered,
] as const;

/**
 * Lets a durable backend re-read only the runs that changed. A read this package's journals make in several statements
 * ends at the next one once `stop` aborts, rejecting with its reason (#5480); any other journal reads to the end.
 */
export interface RunJournalVersions {
	/** Undefined when the journal cannot tell that nothing changed; every run's version is then compared. */
	changeToken(stop?: AbortSignal): Promise<string | undefined>;
	runVersions(stop?: AbortSignal): Promise<ReadonlyMap<string, RunVersion>>;
	snapshotTail(runId: string, stop?: AbortSignal): Promise<RunSnapshotTail | undefined>;
}

/** Change tracking for a journal that implements all three members; other journals are re-read in full. */
export function runJournalVersions(journal: RunJournal): RunJournalVersions | undefined {
	const { changeToken, runVersions, snapshotTail }: Partial<RunJournalVersions> = journal;
	if (typeof changeToken !== "function" || typeof runVersions !== "function" || typeof snapshotTail !== "function")
		return undefined;
	return {
		changeToken: (stop) => changeToken.call(journal, stop),
		runVersions: (stop) => runVersions.call(journal, stop),
		snapshotTail: (runId, stop) => snapshotTail.call(journal, runId, stop),
	};
}

export type RunJournalAppendMany = (
	lease: Lease,
	appends: readonly RunJournalBatchAppend[],
) => Promise<readonly PromiseSettledResult<AppendOutcome>[]>;

/** Batched appends for a journal that implements them; other journals append one event at a time. */
export function runJournalAppendMany(journal: RunJournal): RunJournalAppendMany | undefined {
	const { appendMany } = journal;
	if (typeof appendMany !== "function") return undefined;
	return (lease, appends) => appendMany.call(journal, lease, appends);
}

export type JournalAppendGuard = (tx: SqliteExecutor, runId: string) => Promise<void>;

/** How a pool write goes to its database in one request: see {@link SqlPoolStorage.batch}. */
export interface SqlPoolBatchOptions {
	/** Goes ahead of the journal's other queued calls and of the process's limit on writes in flight: lease renewals. */
	readonly priority?: boolean;
	/**
	 * The audited fenced path the write is (`fenced-paths.ts`): on a database with `SqlPoolStorage.fenced` it runs as a
	 * `fenced` transaction. Without it, such a database runs the write in a `serial` transaction, as before (#5102).
	 */
	readonly audit?: FencedPathId;
	/** The fenced write also excludes whole-database serial transactions (`TransactionConcurrency`). */
	readonly excludesSerial?: boolean;
}

/**
 * Whether the database runs write transactions concurrently and its stores take row locks themselves (PostgreSQL):
 * the dialect then renders a lock clause. SQLite serializes every write, so nothing there takes row locks.
 */
export function locksRows(dialect: StorageDialect): boolean {
	return dialect.lockClause("update") !== "";
}

/**
 * Runs a planned pool write's statements in order in one `fenced` transaction (#5102): no database-wide lock, the
 * fences lock the rows the write decided on. `audit` names the reviewed path (`fenced-paths.ts`).
 */
export type SqlPoolFencedWrite = (
	statements: readonly SqliteStatement[],
	audit: FencedPathId,
	excludesSerial?: boolean,
) => Promise<SqliteRow[][]>;

export interface SqlPoolStorage {
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
	/**
	 * Present when the journal's database sends a batch of statements as one request (a libSQL database): runs them in
	 * order in one write transaction, which holds the write lock for that one request only, and waits for a busy lock as
	 * the journal's transactions do. Resolves with each statement's rows.
	 */
	readonly batch?: (statements: readonly SqliteStatement[], options?: SqlPoolBatchOptions) => Promise<SqliteRow[][]>;
	/**
	 * Present when the journal's database runs transactions concurrently and locks rows (PostgreSQL), and has no
	 * `batch`: an audited pool write's planned statements run as one `fenced` transaction instead of under the database's
	 * write lock, so pool writes of many hosts proceed together.
	 */
	readonly fenced?: SqlPoolFencedWrite;
	/**
	 * A read that never takes the shared write lock. On a node:sqlite journal file it is one read transaction on a
	 * read-only connection to that file: all of its statements see the same last commit, it reads while another
	 * connection holds the lock, and it never waits behind this journal's own writes. On any other database (an
	 * in-memory node:sqlite database, or another adapter's, such as a libSQL `file:` database other processes also open)
	 * its statements run outside any transaction on the journal's own connection: each reads the last commit, and two
	 * statements of one read may see different commits.
	 */
	read<T>(body: (executor: SqliteExecutor) => Promise<T>): Promise<T>;
	readonly peek?: <T>(body: (executor: SqliteExecutor) => Promise<T>) => Promise<T>;
	withAppendGuard<T>(guard: JournalAppendGuard, action: () => Promise<T>): Promise<T>;
	readonly tables: Readonly<{
		runs: string;
		events: string;
		leases: string;
		eventChunks: string;
		leaseBuilds: string;
		meta: string;
	}>;
	/** Whether a process of an older build may be reading the journal now (#4965): see `olderBuildLive`. */
	olderBuildLive(executor: SqliteExecutor): Promise<boolean>;
	/** The journal database's snapshot blob table, which the work a pool queues carries snapshots of (#5077). */
	readonly snapshotBlobs?: SqlSnapshotBlobStore;
	/** The SQL dialect of the journal's database: the pool's statements ask it for what differs between engines. */
	readonly dialect: StorageDialect;
	/** The database's adapter, as its descriptor names it, such as `"libsql"` or `"postgres"`. */
	readonly adapter: string;
	/** Wake-ups through the journal's database, when it delivers them (Postgres): see {@link poolReadyChannel}. */
	readonly notifications?: StorageNotifications;
}

/** The journal's runs table, after the prefix. */
const RUNS_TABLE = "wf_runs";

/**
 * The prefix of a pool's session tables: the pooled-stage session store's, and the pool's own `session_owners`.
 * `<runs>_pool_`, except on a database whose identifiers are limited (Postgres), where the session store's own long
 * names would not fit after it: `<prefix>wf_ps_` there, a name no released store used.
 */
export function poolSessionPrefix(storage: Pick<SqlPoolStorage, "tables" | "dialect">): string {
	const { runs } = storage.tables;
	if (storage.dialect.maxIdentifierBytes === undefined || !runs.endsWith(RUNS_TABLE)) return `${runs}_pool_`;
	return `${runs.slice(0, -RUNS_TABLE.length)}${POSTGRES_POOL_SESSION_PREFIX}`;
}

/**
 * The ledger the pool's stores record their schema revisions in (#5218): the prefix's `atomic_migrations`, as the
 * other stores under the prefix use.
 */
export function poolSchemaLedger(storage: { readonly tables: Pick<SqlPoolStorage["tables"], "runs"> }): string {
	const { runs } = storage.tables;
	return `${runs.endsWith(RUNS_TABLE) ? runs.slice(0, -RUNS_TABLE.length) : `${runs}_`}atomic_migrations`;
}

/**
 * The channel a pool write notifies, with the root's run id, when the transaction that made work ready or ended an
 * attempt commits: `<prefix>pool_ready` (#5103).
 */
export function poolReadyChannel(storage: {
	readonly tables: Pick<SqlPoolStorage["tables"], "runs" | "events" | "leases">;
}): string {
	const { runs } = storage.tables;
	return `${runs.endsWith(RUNS_TABLE) ? runs.slice(0, -RUNS_TABLE.length) : `${runs}_`}pool_ready`;
}

/** The storage errors that say the store did not take a write, rather than that the write itself was refused. */
const STORE_FAILURES = new Set(["StorageUnavailableError", "StorageTransientError", "StorageOutcomeUnknownError"]);

/**
 * This process's writes to one journal's pool tables (#4768): when the oldest still waiting started, by
 * `performance.now()`, and how many in a row the store failed. Status reads it rather than writing to probe the store,
 * since a journal runs one call at a time and a probe the store left unanswered would hold up the run's own calls.
 */
export class SharedStoreWrites {
	private readonly waiting = new Map<number, number>();
	private next = 0;
	failuresInRow = 0;
	lastFailure?: Error;

	async watch<T>(write: () => Promise<T>): Promise<T> {
		const id = this.next++;
		this.waiting.set(id, performance.now());
		try {
			const result = await write();
			this.failuresInRow = 0;
			return result;
		} catch (error) {
			if (STORE_FAILURES.has((error as Error).name)) {
				this.failuresInRow += 1;
				this.lastFailure = error as Error;
			}
			throw error;
		} finally {
			this.waiting.delete(id);
		}
	}

	/** How long the oldest write still waiting has waited; undefined when none waits. */
	oldestWaitingMs(): number | undefined {
		if (this.waiting.size === 0) return undefined;
		return performance.now() - Math.min(...this.waiting.values());
	}
}

const poolStorage = new WeakMap<RunJournal, SqlPoolStorage>();
const poolWrites = new WeakMap<RunJournal, SharedStoreWrites>();

/** Registers `journal`'s pool storage, whose writes status watches to tell a store that stopped committing (#4768). */
export function registerSqlPoolStorage(journal: RunJournal, storage: SqlPoolStorage): void {
	const writes = new SharedStoreWrites();
	poolWrites.set(journal, writes);
	const { batch, fenced } = storage;
	poolStorage.set(journal, {
		...storage,
		transaction: (body) => writes.watch(() => storage.transaction(body)),
		// A batched pool write is watched per send, as a transaction is.
		...(batch === undefined
			? {}
			: { batch: (statements, options) => writes.watch(() => batch(statements, options)) }),
		...(fenced === undefined
			? {}
			: {
					fenced: (statements, audit, excludesSerial) =>
						writes.watch(() => fenced(statements, audit, excludesSerial)),
				}),
	});
}

/** This process's writes to `journal`'s pool tables, for status; undefined for a journal that is not SQL. */
export function sqlPoolWrites(journal: RunJournal): SharedStoreWrites | undefined {
	return poolWrites.get(journal);
}

export function sqlPoolStorage(journal: RunJournal): SqlPoolStorage | undefined {
	return poolStorage.get(journal);
}

/**
 * Calls `listener` with the root's run id each time a pool write on `journal` makes that root's work ready or ends one
 * of its attempts, and with undefined when notifications may have been missed (#5103). Undefined when the journal's
 * database delivers no notifications; callers keep polling either way.
 */
export function listenPoolReady(
	journal: RunJournal,
	listener: (root: string | undefined) => void,
): StorageNotificationSubscription | undefined {
	const storage = poolStorage.get(journal);
	const notifications = storage?.notifications;
	if (storage === undefined || notifications === undefined) return undefined;
	return notifications.listen(poolReadyChannel(storage), (event) =>
		listener(event.kind === "notification" ? event.payload : undefined),
	);
}

/**
 * Calls `observe` as each pool transaction or batch on `journal` begins, for the transactions of the pool tables (queue, usage,
 * admission) opened on it from now on: a pool coordinator counts its journal writes this way.
 */
export function observeSqlPoolTransactions(journal: RunJournal, observe: () => void): void {
	const storage = poolStorage.get(journal);
	if (storage === undefined) return;
	const { batch, fenced } = storage;
	poolStorage.set(journal, {
		...storage,
		transaction: (body) => {
			observe();
			return storage.transaction(body);
		},
		...(fenced === undefined
			? {}
			: {
					fenced: (statements, audit, excludesSerial) => {
						observe();
						return fenced(statements, audit, excludesSerial);
					},
				}),
		...(batch === undefined
			? {}
			: {
					batch: (statements, options) => {
						observe();
						return batch(statements, options);
					},
				}),
	});
}

export const STAGE_OVERVIEW_PAYLOAD_CHARS = 4096;

interface StageOverviewAttempt {
	readonly model: string;
	readonly success: boolean;
	readonly usage?: unknown;
}

interface StageOverviewCheckpoint {
	readonly kind: "stage";
	readonly workflowId?: unknown;
	readonly checkpointId?: unknown;
	readonly name?: unknown;
	readonly replayKey?: unknown;
	readonly completedAt?: unknown;
	readonly topology?: unknown;
	readonly sessionId?: unknown;
	readonly output?: unknown;
	readonly startedAt?: unknown;
	readonly endedAt?: unknown;
	readonly durationMs?: unknown;
	readonly modelAttempts?: readonly StageOverviewAttempt[];
	readonly worktreeSnapshots?: unknown;
}

function isStageCheckpointRecord(value: object): value is StageOverviewCheckpoint {
	return "kind" in value && value.kind === "stage";
}

function stageOverviewPayloadStub(checkpoint: StageOverviewCheckpoint): string {
	return JSON.stringify({
		overviewStub: 1,
		kind: checkpoint.kind,
		workflowId: checkpoint.workflowId,
		checkpointId: checkpoint.checkpointId,
		name: checkpoint.name,
		replayKey: checkpoint.replayKey,
		completedAt: checkpoint.completedAt,
		...(checkpoint.topology === undefined ? {} : { topology: checkpoint.topology }),
		...(checkpoint.sessionId === undefined ? {} : { sessionId: checkpoint.sessionId }),
		...(checkpoint.output === undefined ? {} : { output: null }),
		...(checkpoint.startedAt === undefined ? {} : { startedAt: checkpoint.startedAt }),
		...(checkpoint.endedAt === undefined ? {} : { endedAt: checkpoint.endedAt }),
		...(checkpoint.durationMs === undefined ? {} : { durationMs: checkpoint.durationMs }),
		...(checkpoint.modelAttempts === undefined
			? {}
			: {
					modelAttempts: checkpoint.modelAttempts.map(({ model, success, usage }) => ({
						model,
						success,
						...(usage === undefined ? {} : { usage }),
					})),
				}),
		...(checkpoint.worktreeSnapshots === undefined ? {} : { worktreeSnapshots: checkpoint.worktreeSnapshots }),
	});
}

export function storedEventPayload(type: string, json: string, value?: unknown): StoredJournalPayload {
	if (type === RUN_EVENT_TYPES.checkpointRecorded && json.length > STAGE_OVERVIEW_PAYLOAD_CHARS) {
		const parsed = value === undefined ? (JSON.parse(json) as unknown) : value;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && isStageCheckpointRecord(parsed)) {
			return {
				payload: stageOverviewPayloadStub(parsed),
				chunks: storedJsonChunks(json) ?? [Buffer.from(json, "utf8")],
			};
		}
	}
	return storedJournalPayload(json, value);
}

export interface JournalKeyRangeReadOptions {
	readonly overview?: boolean;
}

/** A run's events whose key is at least `fromKey` and below `toKey`, read through the journal's key index. */
export type JournalKeyRangeRead = (
	runId: string,
	fromKey: string,
	toKey: string,
	options?: JournalKeyRangeReadOptions,
) => AsyncIterable<JournalEntry>;

const keyRangeReads = new WeakMap<RunJournal, JournalKeyRangeRead>();

/** Lets a durable backend read the journal's checkpoints by key range (`SqlRunJournal.readKeyRange`). */
export function registerJournalKeyRangeRead(journal: RunJournal, read: JournalKeyRangeRead): void {
	keyRangeReads.set(journal, read);
}

export function journalKeyRangeRead(journal: RunJournal): JournalKeyRangeRead | undefined {
	return keyRangeReads.get(journal);
}
