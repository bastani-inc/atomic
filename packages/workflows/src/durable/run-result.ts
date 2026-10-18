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
 * inspection. Each changed result gets its own checkpoint, because the journal
 * ignores a repeated checkpoint ID; the latest record (by `completedAt`) wins on
 * hydration, so a resumed run that finishes with different outputs, including
 * outputs it returned before, supersedes the earlier record.
 */

import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowOutputValues, WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./durable-hash.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint name AND args-hash for the run's final outputs. */
export const RUN_RESULT_CHECKPOINT_NAME = "workflow-run-result";
const RUN_RESULT_CHECKPOINT_ID_PREFIX = "run-result:";

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
	run: Pick<RunSnapshot, "id" | "result">,
): Promise<boolean> {
	const result = run.result;
	const hasResult = result !== undefined && Object.keys(result).length > 0;
	const recorded = backend.getToolCheckpoint(run.id, RUN_RESULT_CHECKPOINT_NAME);
	if (!hasResult && recorded === undefined) return false;
	if (backend.listCheckpoints(run.id).length === 0) return false;
	const output = hasResult ? { result } : {};
	if (recorded !== undefined && durableHash(recorded.output) === durableHash(output)) return false;
	const previousSequence = Number(recorded?.checkpointId.slice(RUN_RESULT_CHECKPOINT_ID_PREFIX.length));
	const sequence = Number.isSafeInteger(previousSequence) ? previousSequence + 1 : 1;
	const completedAt = Math.max(Date.now(), recorded?.completedAt ?? 0);
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId: run.id,
		checkpointId: `${RUN_RESULT_CHECKPOINT_ID_PREFIX}${sequence}`,
		name: RUN_RESULT_CHECKPOINT_NAME,
		argsHash: RUN_RESULT_CHECKPOINT_NAME,
		output,
		completedAt,
	} satisfies DurableToolCheckpoint);
	return true;
}
