import type { SqliteExecutor } from "@bastani/atomic/storage";
import type { RunJournal } from "./types.js";

export const JOURNAL_READ_PAGE_SIZE = 256;

/** A run's latest event. A run whose history was deleted and recorded again ends with a different event. */
export interface RunVersion {
	readonly seq: number;
	readonly at: number;
}

/** Lets a durable backend re-read only the runs that changed; kept off the public journal shape. */
export interface RunJournalVersions {
	/** Moves whenever any connection, in this process or another, commits a change to the journal's store. */
	changeToken(): Promise<string>;
	/** Every listed run with its latest event; a run with no events has version `{ seq: 0, at: 0 }`. */
	runVersions(): Promise<ReadonlyMap<string, RunVersion>>;
}

const versionReaders = new WeakMap<RunJournal, RunJournalVersions>();

export function registerRunJournalVersions(journal: RunJournal, versions: RunJournalVersions): void {
	versionReaders.set(journal, versions);
}

/** Change tracking for a journal that registered it; other journals are re-read in full. */
export function runJournalVersions(journal: RunJournal): RunJournalVersions | undefined {
	return versionReaders.get(journal);
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
