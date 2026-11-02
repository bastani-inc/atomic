import type { SqliteExecutor, SqliteTransactionOptions } from "@bastani/atomic/storage";
import {
	type AppendOutcome,
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
	/** Statements outside any transaction: they read the last commit without taking the shared write lock. */
	read<T>(body: (executor: SqliteExecutor) => Promise<T>): Promise<T>;
	withAppendGuard<T>(guard: JournalAppendGuard, action: () => Promise<T>): Promise<T>;
	readonly tables: Readonly<{ runs: string; events: string; leases: string }>;
}

const poolStorage = new WeakMap<RunJournal, SqlPoolStorage>();

export function registerSqlPoolStorage(journal: RunJournal, storage: SqlPoolStorage): void {
	poolStorage.set(journal, storage);
}

export function sqlPoolStorage(journal: RunJournal): SqlPoolStorage | undefined {
	return poolStorage.get(journal);
}
