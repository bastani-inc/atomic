import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableWorkflowHandle } from "./types.js";

/** A later claim can change the status before its executor records the next attempt. Match both boundaries. */
export function blockAttemptKey(backend: DurableWorkflowBackend, id: string): string {
	return `${backend.workflowAttempt?.(id) ?? 0}:${backend.getWorkflow(id)?.transitionClaimId ?? ""}`;
}

/** Older block entries do not name a generation; only an unclaimed first attempt is unambiguous. */
export function hasUncommittedSessionBlock(
	backend: DurableWorkflowBackend,
	handle: DurableWorkflowHandle,
	run: RunSnapshot | undefined,
): boolean {
	return (
		handle.status === "running" &&
		handle.resumable !== false &&
		run?.restored === true &&
		run.blockedAt !== undefined &&
		run.modelOwner === handle.modelOwner &&
		(run.blockAttempt ?? "0:") === blockAttemptKey(backend, handle.workflowId)
	);
}
