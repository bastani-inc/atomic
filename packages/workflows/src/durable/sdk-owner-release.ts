import type { DurableWorkflowBackend } from "./backend.js";

/**
 * Durably release the paused runs a disposed session still owns, so another SDK
 * session may adopt them. A crash never reaches this point, so a run whose owner
 * died without disposing stays owned and is refused.
 */
export async function releasePausedRunsOwnedBy(backend: DurableWorkflowBackend, modelOwner: string): Promise<void> {
	const settled = await Promise.allSettled(
		backend
			.listResumableWorkflows()
			.filter((entry) => entry.status === "paused" && entry.modelOwner === modelOwner)
			.map((entry) =>
				backend.transitionWorkflowStatus(
					entry.workflowId,
					["paused"],
					"paused",
					undefined,
					undefined,
					undefined,
					undefined,
					modelOwner,
				),
			),
	);
	const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join("; "));
}
