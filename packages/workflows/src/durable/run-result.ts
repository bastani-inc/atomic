/**
 * Durable run-level final outputs.
 *
 * Persists the final outputs (`RunSnapshot.result`) of a top-level workflow run
 * so a session that did not start the run can still read what it produced when
 * it rebuilds the run from the journal.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-run-result`), following `run-timing.ts`. Tool checkpoints are ignored
 * by stage-graph reconstruction, so no phantom nodes appear in durable
 * inspection. The latest record (by `completedAt`) wins on hydration, so a
 * resumed run that finishes with different outputs supersedes an earlier record.
 */

import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowOutputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./durable-hash.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name AND args-hash for the run's final outputs. */
export const RUN_RESULT_CHECKPOINT_NAME = "workflow-run-result";

function isOutputValues(value: WorkflowSerializableValue | undefined): value is WorkflowOutputValues {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Final outputs recorded durably, or undefined when absent. */
export function durableRunResult(
	backend: DurableWorkflowBackend,
	workflowId: string,
): WorkflowOutputValues | undefined {
	const output = backend.getToolOutput(workflowId, RUN_RESULT_CHECKPOINT_NAME);
	if (!isOutputValues(output)) return undefined;
	const result = output.result;
	return isOutputValues(result) ? result : undefined;
}

/**
 * Record the run's final outputs durably before its terminal status is committed.
 *
 * Skipped when the run has no durable progress (a record with nothing to inspect
 * would only manufacture a checkpoint) and when there are no outputs to record
 * and no earlier record to supersede.
 */
export async function recordRunResultCheckpointAsync(
	backend: DurableWorkflowBackend,
	run: RunSnapshot,
): Promise<boolean> {
	const result = run.result;
	const hasResult = result !== undefined && Object.keys(result).length > 0;
	const recorded = backend.getToolCheckpoint(run.id, RUN_RESULT_CHECKPOINT_NAME);
	if (!hasResult && recorded === undefined) return false;
	if (backend.listCheckpoints(run.id).length === 0) return false;
	const checkpointId = `run-result:${hasResult ? durableHash({ result }) : "none"}`;
	if (recorded?.checkpointId === checkpointId) return false;
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId: run.id,
		checkpointId,
		name: RUN_RESULT_CHECKPOINT_NAME,
		argsHash: RUN_RESULT_CHECKPOINT_NAME,
		output: hasResult ? { result } : {},
		completedAt: Date.now(),
	} satisfies DurableToolCheckpoint);
	return true;
}
