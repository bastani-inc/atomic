import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";

const backends: JournalDurableBackend<MemoryRunJournal>[] = [];
export async function closeMemoryTestBackends(): Promise<void> {
	for (const backend of backends.splice(0)) await backend.close();
}

export type MemoryJournalBackend = JournalDurableBackend<MemoryRunJournal>;

export async function createMemoryTestBackend(): Promise<MemoryJournalBackend> {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	backends.push(backend);
	return backend;
}
