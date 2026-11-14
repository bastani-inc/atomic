import type { DurableWorkflowBackend } from "../durable/backend.js";
import { JournalDurableBackend } from "../durable/journal/journal-backend.js";
import { unknownSharedStore, withinStatusBudget } from "../durable/journal/shared-store-health.js";
import { readSharedPoolStats } from "../durable/journal/sql-shared-pool.js";
import type { SharedPoolStatus } from "./shared-pool-status-lines.js";

/**
 * The shared pool of root `runId` as workflow status shows it, when the root runs its pool on a shared journal; nothing
 * for any other run. A pool whose tables cannot be read, or that does not answer within the status budget, is reported
 * with the error that stopped the read and a hint for a store that stopped taking writes: status never waits on it.
 */
export async function sharedPoolStatus(
	backend: DurableWorkflowBackend | undefined,
	runId: string,
): Promise<SharedPoolStatus | undefined> {
	if (!(backend instanceof JournalDurableBackend)) return undefined;
	if (backend.getWorkflow(runId)?.resources?.workers?.placement !== "shared") return undefined;
	try {
		const stats = await withinStatusBudget(readSharedPoolStats(backend.journal, runId));
		return stats === undefined ? undefined : { sharedPool: stats };
	} catch (error) {
		const { message, hint } = unknownSharedStore(error);
		return {
			sharedPoolUnavailable: {
				name: error instanceof Error ? error.name : "Error",
				message,
				hint,
			},
		};
	}
}
