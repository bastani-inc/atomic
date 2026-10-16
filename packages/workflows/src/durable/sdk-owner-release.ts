import type { DurableWorkflowBackend } from "./backend.js";

const releasedRuns = new WeakMap<DurableWorkflowBackend, Set<string>>();

/**
 * Durably release the paused runs a departing session still owns (it was disposed, or switched
 * to another session), so another session may adopt them. A crash never reaches this point, so a
 * run whose owner died without leaving stays owned and is refused. Returns the released run ids.
 */
export async function releasePausedRunsOwnedBy(
	backend: DurableWorkflowBackend,
	modelOwner: string,
): Promise<readonly string[]> {
	const settled = await Promise.allSettled(
		backend
			.listResumableWorkflows()
			.filter((entry) => entry.status === "paused" && entry.modelOwner === modelOwner)
			.map(async (entry) => {
				const released = await backend.commitWorkflowStatusTransition(
					entry.workflowId,
					["paused"],
					"paused",
					undefined,
					undefined,
					undefined,
					undefined,
					modelOwner,
				);
				return released ? entry.workflowId : undefined;
			}),
	);
	const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join("; "));
	const releasedIds = settled.flatMap((result) =>
		result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
	);
	let remembered = releasedRuns.get(backend);
	if (remembered === undefined) {
		remembered = new Set();
		releasedRuns.set(backend, remembered);
	}
	for (const runId of releasedIds) remembered.add(runId);
	return releasedIds;
}

/**
 * A session that becomes current again takes back the runs it released earlier, so no other session can adopt
 * a run its live owner is back on. Only the owner's own release records are cleared; the owner stays unchanged.
 */
export async function reclaimReleasedRunsOwnedBy(backend: DurableWorkflowBackend, modelOwner: string): Promise<void> {
	const settled = await Promise.allSettled(
		backend
			.listResumableWorkflows()
			.filter((entry) => entry.status === "paused" && entry.modelOwner === modelOwner)
			.flatMap((entry) => {
				const handle = backend.getWorkflow(entry.workflowId);
				return handle?.releasedModelOwner === modelOwner ? [handle] : [];
			})
			.map(async (handle) => {
				const reclaimed = await backend.commitWorkflowStatusTransition(
					handle.workflowId,
					["paused"],
					"paused",
					undefined,
					undefined,
					handle.updatedAt,
				);
				if (reclaimed) releasedRuns.get(backend)?.delete(handle.workflowId);
			}),
	);
	const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join("; "));
}

const FOREIGN_INSTANCE_MESSAGE = "Workflow instance belongs to another caller/session.";

/**
 * Refusal text for a session that does not own the run. A run this process released that another
 * session has since adopted (its release record is gone and a different session owns it) says so;
 * every other case keeps the generic message.
 */
export function foreignInstanceMessage(backend: DurableWorkflowBackend, runId: string): string {
	return releasedRuns.get(backend)?.has(runId) === true && backend.getWorkflow(runId)?.releasedModelOwner === undefined
		? `Workflow ${runId} is now owned by another session; it was already adopted after its previous session was switched away.`
		: FOREIGN_INSTANCE_MESSAGE;
}
