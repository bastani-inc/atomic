import type { SqliteExecutor } from "@bastani/atomic/storage";
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
