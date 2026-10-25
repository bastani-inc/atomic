import type { SqliteExecutor } from "@bastani/atomic/storage";
import {
	type AppendOutcome,
	type JournalEntry,
	type Lease,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunJournal,
} from "./types.js";

export const JOURNAL_READ_PAGE_SIZE = 256;

/** Event types the durable backend folds without replacing the run's handle; every other event carries it. */
export const NON_SNAPSHOT_EVENT_TYPES = [
	RUN_EVENT_TYPES.checkpointRecorded,
	RUN_EVENT_TYPES.messageSettled,
	RUN_EVENT_TYPES.messageDelivered,
] as const;

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

/** Lets a durable backend re-read only the runs that changed; kept off the public journal shape. */
export interface RunJournalVersions {
	/** Moves whenever any connection, in this process or another, commits a change to the journal's store. */
	changeToken(): Promise<string>;
	/** Every listed run with its latest event; a run with no events has version `{ seq: 0, at: 0 }`. */
	runVersions(): Promise<ReadonlyMap<string, RunVersion>>;
	/** Undefined for a run with no snapshot event. */
	snapshotTail(runId: string): Promise<RunSnapshotTail | undefined>;
}

const versionReaders = new WeakMap<RunJournal, RunJournalVersions>();

export function registerRunJournalVersions(journal: RunJournal, versions: RunJournalVersions): void {
	versionReaders.set(journal, versions);
}

/** Change tracking for a journal that registered it; other journals are re-read in full. */
export function runJournalVersions(journal: RunJournal): RunJournalVersions | undefined {
	return versionReaders.get(journal);
}

/**
 * One append of a batch. `context` runs a function in the async context the append was issued from; that context,
 * not the batch's, decides the append's pool append guard.
 */
export interface JournalBatchAppend {
	readonly event: RunEvent;
	readonly key?: string;
	readonly context: <R>(action: () => R) => R;
}

/** Appends to one run in one transaction; each append is settled on its own. Kept off the public journal shape. */
export type RunJournalAppendMany = (
	lease: Lease,
	appends: readonly JournalBatchAppend[],
) => Promise<readonly PromiseSettledResult<AppendOutcome>[]>;

const appendManyWriters = new WeakMap<RunJournal, RunJournalAppendMany>();

export function registerRunJournalAppendMany(journal: RunJournal, appendMany: RunJournalAppendMany): void {
	appendManyWriters.set(journal, appendMany);
}

/** Batched appends for a journal that registered them; other journals append one event at a time. */
export function runJournalAppendMany(journal: RunJournal): RunJournalAppendMany | undefined {
	return appendManyWriters.get(journal);
}

export type JournalAppendGuard = (tx: SqliteExecutor, runId: string) => Promise<void>;

export interface SqlPoolStorage {
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
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
