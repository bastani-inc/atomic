import type { ToolNodeSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { workflowToolFailure } from "./tool-outcome.js";
import { DURABLE_TOOL_TOPOLOGY_VERSION, type DurableStageRunTopology } from "./types.js";

export interface ThrowingToolFailureCheckpointInput {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextCheckpointId: () => string;
	readonly runTopology?: DurableStageRunTopology;
}

/** Persist a throwing failure for inspection without making it replayable. */
export async function recordThrowingToolFailure(
	input: ThrowingToolFailureCheckpointInput,
	node: ToolNodeSnapshot,
	identity: {
		readonly name: string;
		readonly argsHash: string;
		readonly ordinal: number;
		readonly startedAt: number;
	},
	error: unknown,
	attempts: number,
): Promise<{ readonly message: string; readonly failedAt: number }> {
	const message = workflowToolFailure(error, attempts, false).error.message;
	const failedAt = Date.now();
	await input.backend.recordAdditiveCheckpointBestEffort({
		kind: "tool",
		workflowId: input.workflowId,
		checkpointId: `tool-failure:${identity.argsHash}:${input.nextCheckpointId()}`,
		name: identity.name,
		argsHash: identity.argsHash,
		output: null,
		throwingFailureError: message,
		completedAt: failedAt,
		topology: {
			version: DURABLE_TOOL_TOPOLOGY_VERSION,
			nodeId: node.id,
			ordinal: identity.ordinal,
			order: node.executionOrder ?? 0,
			parentIds: [...node.parentIds],
			startedAt: identity.startedAt,
			endedAt: failedAt,
			...(input.runTopology !== undefined ? { run: { ...input.runTopology } } : {}),
		},
	});
	return { message, failedAt };
}
