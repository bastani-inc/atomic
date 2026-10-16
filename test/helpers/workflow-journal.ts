import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { PromptReservationToken } from "../../packages/workflows/src/durable/prompt-reservation-state.js";

const backends: JournalDurableBackend<MemoryRunJournal>[] = [];
export async function closeMemoryTestBackends(): Promise<void> {
	for (const backend of backends.splice(0)) await backend.close();
}

export class MemoryJournalBackend extends JournalDurableBackend<MemoryRunJournal> {
	constructor() {
		super(new MemoryRunJournal());
		backends.push(this);
	}

	override pendingPromptToken(runId: string, reservationId: string): PromptReservationToken | undefined {
		return super.pendingPromptToken(runId, reservationId) as PromptReservationToken | undefined;
	}

	override reservePendingPrompt(runId: string, reservationId: string): PromptReservationToken {
		return super.reservePendingPrompt(runId, reservationId) as PromptReservationToken;
	}
}

export function createMemoryTestBackend(): MemoryJournalBackend {
	return new MemoryJournalBackend();
}
