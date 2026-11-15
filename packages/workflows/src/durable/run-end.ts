/**
 * Durable record that a root run's definition completed (#5133).
 *
 * A run commits its terminal status as one write to the run's handle. When the store refuses that write, and its retry,
 * the handle still says `running`, though the run's work is done. So, before the status, the run records that its
 * definition completed in its current attempt. The record is a run-timing record (`run-timing.ts`) carrying the run's
 * elapsed time as every timing record does: every release reads it as timing, and none as a graph node. A handle still
 * `running` whose run recorded this in the attempt it is in reads as completed.
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "./types.js";

/** `RUN_TIMING_CHECKPOINT_NAME` of `run-timing.ts`, whose imports a reader of this record need not load. */
const RUN_TIMING_CHECKPOINT_NAME = "workflow-run-timing";

/** Checkpoint id prefix of the record that a run's definition completed. */
export const RUN_END_CHECKPOINT_ID_PREFIX = "run-end:";

/** The attempt a run-end record says completed, or undefined for any other checkpoint. */
export function completedRunAttempt(checkpoint: DurableCheckpoint): number | undefined {
	if (checkpoint.kind !== "tool" || !checkpoint.checkpointId.startsWith(RUN_END_CHECKPOINT_ID_PREFIX))
		return undefined;
	const attempt = (checkpoint.output as { readonly completedAttempt?: unknown } | null)?.completedAttempt;
	return typeof attempt === "number" ? attempt : undefined;
}

/** Record, before its status, that the current attempt of root run `workflowId` completed. */
export async function recordRunCompletedCheckpointAsync(
	backend: DurableWorkflowBackend,
	workflowId: string,
): Promise<void> {
	const attempt = backend.workflowAttempt?.(workflowId) ?? 0;
	const timing = backend.getToolOutput(workflowId, RUN_TIMING_CHECKPOINT_NAME) as {
		readonly elapsedMs?: unknown;
	} | null;
	const elapsedMs = typeof timing?.elapsedMs === "number" ? timing.elapsedMs : undefined;
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: `${RUN_END_CHECKPOINT_ID_PREFIX}${attempt}`,
		name: RUN_TIMING_CHECKPOINT_NAME,
		argsHash: RUN_TIMING_CHECKPOINT_NAME,
		output: { ...(elapsedMs === undefined ? {} : { elapsedMs }), completedAttempt: attempt },
		completedAt: Date.now(),
	} satisfies DurableToolCheckpoint);
}
