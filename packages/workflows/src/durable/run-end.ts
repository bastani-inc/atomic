/**
 * Durable record that a root run's definition finished (#5133).
 *
 * A run commits its terminal status as one write to the run's handle. When the store refuses that write, and its retry,
 * the handle still says `running`, though the run's work is done. So, before the status, the run records that its
 * definition returned and completed, as a reserved tool-kind checkpoint like `run-timing.ts` (no graph node). A handle
 * still `running` whose run recorded this in the attempt it is in reads as completed.
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name and args-hash of the record that a run's definition completed. */
export const RUN_END_CHECKPOINT_NAME = "workflow-run-end";
const RUN_END_CHECKPOINT_ID_PREFIX = "run-end:";

/** The attempt a run-end record says completed, or undefined for any other checkpoint. */
export function completedRunAttempt(checkpoint: DurableCheckpoint): number | undefined {
	if (checkpoint.kind !== "tool" || checkpoint.argsHash !== RUN_END_CHECKPOINT_NAME) return undefined;
	const output = checkpoint.output as { readonly status?: unknown; readonly attempt?: unknown } | null;
	return output?.status === "completed" && typeof output.attempt === "number" ? output.attempt : undefined;
}

/** Record, before its status, that attempt `attempt` of root run `workflowId` completed. */
export async function recordRunCompletedCheckpointAsync(
	backend: DurableWorkflowBackend,
	workflowId: string,
): Promise<void> {
	const attempt = backend.workflowAttempt?.(workflowId) ?? 0;
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: `${RUN_END_CHECKPOINT_ID_PREFIX}${attempt}`,
		name: RUN_END_CHECKPOINT_NAME,
		argsHash: RUN_END_CHECKPOINT_NAME,
		output: { status: "completed", attempt },
		completedAt: Date.now(),
	} satisfies DurableToolCheckpoint);
}
