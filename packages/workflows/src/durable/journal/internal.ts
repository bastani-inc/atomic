import type {
	AppendOutcome,
	JournalEntry,
	Lease,
	LeaseOutcome,
	LeaseState,
	RunEvent,
	RunHeader,
	RunJournal,
	RunSummary,
} from "./types.js";

export const JOURNAL_READ_PAGE_SIZE = 256;

export interface SynchronousRunJournal {
	createRunSync(header: RunHeader): "created" | "exists";
	listRunsSync(filter?: { cwd?: string }): readonly RunSummary[];
	takeoverExpiredSync(runId: string, holderId: string, staleAfterMs: number): LeaseOutcome;
	leaseStateSync(runId: string): LeaseState | undefined;
	renewSync(lease: Lease): void;
	releaseSync(lease: Lease): void;
	appendSync(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): AppendOutcome;
	readEntries(runId: string, fromSeq?: number): readonly JournalEntry[];
	deleteRunSync(runId: string): void;
}

const synchronousJournals = new WeakMap<RunJournal, SynchronousRunJournal>();

export function registerSynchronousJournal(journal: RunJournal, synchronous: SynchronousRunJournal): void {
	synchronousJournals.set(journal, synchronous);
}

export function synchronousJournal(journal: RunJournal): SynchronousRunJournal | undefined {
	return synchronousJournals.get(journal);
}
