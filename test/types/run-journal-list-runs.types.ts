import type { RunJournal as StorageRunJournal } from "@bastani/atomic/storage";
import type { RunJournal } from "@bastani/atomic/workflows";

// A custom journal's existing one-argument implementation remains valid (#5537).
export const legacyCatalog: Pick<RunJournal, "listRuns"> = {
	async listRuns(_filter?: { cwd?: string }) {
		return [];
	},
};

export async function cancellableRunCatalog(journal: RunJournal, storageJournal: StorageRunJournal): Promise<void> {
	const controller = new AbortController();
	await journal.listRuns({ cwd: "/project" }, { signal: controller.signal });
	await storageJournal.listRuns(undefined, { signal: controller.signal });
	await journal.listRuns();
	// @ts-expect-error Cancellation must use an AbortSignal (#5537).
	await journal.listRuns(undefined, { signal: "cancel" });
}
