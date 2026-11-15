import type {
	FencedPathId,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	StorageDialect,
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

export const JOURNAL_READ_PAGE_SIZE = 256;
/**
 * The most characters of event payload one journal read returns, by the payload's `length()`, so a page of large
 * checkpoints stays under a libSQL server's 10 MB response limit: a character is at most four bytes of UTF-8 (#4954).
 * A page ends with the event that takes it past this, so one event larger than this is a page of its own.
 */
export const JOURNAL_READ_PAGE_CHARS = 1024 * 1024;

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

/** Lets a durable backend re-read only the runs that changed. */
export interface RunJournalVersions {
	/** Undefined when the journal cannot tell that nothing changed; every run's version is then compared. */
	changeToken(): Promise<string | undefined>;
	runVersions(): Promise<ReadonlyMap<string, RunVersion>>;
	snapshotTail(runId: string): Promise<RunSnapshotTail | undefined>;
}

/** Change tracking for a journal that implements all three members; other journals are re-read in full. */
export function runJournalVersions(journal: RunJournal): RunJournalVersions | undefined {
	const { changeToken, runVersions, snapshotTail } = journal;
	if (typeof changeToken !== "function" || typeof runVersions !== "function" || typeof snapshotTail !== "function")
		return undefined;
	return {
		changeToken: () => changeToken.call(journal),
		runVersions: () => runVersions.call(journal),
		snapshotTail: (runId) => snapshotTail.call(journal, runId),
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
	withAppendGuard<T>(guard: JournalAppendGuard, action: () => Promise<T>): Promise<T>;
	readonly tables: Readonly<{ runs: string; events: string; leases: string }>;
	/** The SQL dialect of the journal's database: the pool's statements ask it for what differs between engines. */
	readonly dialect: StorageDialect;
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
	return `${runs.slice(0, -RUNS_TABLE.length)}wf_ps_`;
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
		...(fenced === undefined ? {} : { fenced: (statements, audit) => writes.watch(() => fenced(statements, audit)) }),
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
					fenced: (statements, audit) => {
						observe();
						return fenced(statements, audit);
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

/** A run's events whose key is at least `fromKey` and below `toKey`, read through the journal's key index. */
export type JournalKeyRangeRead = (runId: string, fromKey: string, toKey: string) => AsyncIterable<JournalEntry>;

const keyRangeReads = new WeakMap<RunJournal, JournalKeyRangeRead>();

/** Lets a durable backend read the journal's checkpoints by key range (`SqlRunJournal.readKeyRange`). */
export function registerJournalKeyRangeRead(journal: RunJournal, read: JournalKeyRangeRead): void {
	keyRangeReads.set(journal, read);
}

export function journalKeyRangeRead(journal: RunJournal): JournalKeyRangeRead | undefined {
	return keyRangeReads.get(journal);
}
