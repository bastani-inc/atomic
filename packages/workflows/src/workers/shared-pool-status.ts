import type { DurableWorkflowBackend } from "../durable/backend.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { readSharedPoolStats } from "../durable/journal/sql-shared-pool.js";
import type { SharedPoolStatus } from "./shared-pool-status-lines.js";

/**
 * The shared pool of root `runId` as workflow status shows it, when the root runs its pool on a shared journal; nothing
 * for any other run. A pool whose tables cannot be read is reported with the error that stopped the read.
 */
export async function sharedPoolStatus(
	backend: DurableWorkflowBackend | undefined,
	runId: string,
): Promise<SharedPoolStatus | undefined> {
	if (!(backend instanceof JournalDurableBackend)) return undefined;
	if (backend.getWorkflow(runId)?.resources?.workers?.placement !== "shared") return undefined;
	try {
		const stats = await readSharedPoolStats(backend.journal, runId);
		return stats === undefined ? undefined : { sharedPool: stats };
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		return { sharedPoolUnavailable: { name: failure.name, message: failure.message } };
	}
}
