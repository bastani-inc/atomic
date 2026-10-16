import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";

export async function readJournalEntries(journal: RunJournal, runId: string): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const entry of journal.read(runId)) entries.push(entry);
	return entries;
}
