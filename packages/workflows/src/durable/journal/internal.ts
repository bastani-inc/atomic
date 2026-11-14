import type { SqliteExecutor, SqliteTransactionOptions } from "@bastani/atomic/storage";
import { SharedStoreWrites } from "./shared-store-health.js";
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
	changeToken(): Promise<string>;
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

export interface SqlPoolStorage {
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
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
}

const poolStorage = new WeakMap<RunJournal, SqlPoolStorage>();
const poolWrites = new WeakMap<RunJournal, SharedStoreWrites>();

/** Registers `journal`'s pool storage, whose writes status watches to tell a store that stopped committing (#4768). */
export function registerSqlPoolStorage(journal: RunJournal, storage: SqlPoolStorage): void {
	const writes = new SharedStoreWrites();
	poolWrites.set(journal, writes);
	poolStorage.set(journal, { ...storage, transaction: (body) => writes.watch(() => storage.transaction(body)) });
}

/** This process's writes to `journal`'s pool tables, for status; undefined for a journal that is not SQL. */
export function sqlPoolWrites(journal: RunJournal): SharedStoreWrites | undefined {
	return poolWrites.get(journal);
}

export function sqlPoolStorage(journal: RunJournal): SqlPoolStorage | undefined {
	return poolStorage.get(journal);
}

/**
 * Calls `observe` as each pool transaction on `journal` begins, for the transactions of the pool tables (queue, usage,
 * admission) opened on it from now on: a pool coordinator counts its journal writes this way.
 */
export function observeSqlPoolTransactions(journal: RunJournal, observe: () => void): void {
	const storage = poolStorage.get(journal);
	if (storage === undefined) return;
	poolStorage.set(journal, {
		...storage,
		transaction: (body) => {
			observe();
			return storage.transaction(body);
		},
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
