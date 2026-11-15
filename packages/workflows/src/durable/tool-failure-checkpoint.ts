import type { ToolNodeSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import { checkpointAttempt, durableWorkflowAttempt } from "./attempt-identity.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { workflowToolFailure } from "./tool-outcome.js";
import { DURABLE_TOOL_TOPOLOGY_VERSION, type DurableStageRunTopology } from "./types.js";

export interface ThrowingToolFailureCheckpointInput {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextCheckpointId: () => string;
	readonly beforeCheckpoint?: () => void | Promise<void>;
	readonly runTopology?: DurableStageRunTopology;
}

/** Persist a throwing failure for inspection without making it replayable. */
export async function recordThrowingToolFailure(
	input: ThrowingToolFailureCheckpointInput,
	node: ToolNodeSnapshot,
	identity: {
		readonly name: string;
		readonly args?: Readonly<Record<string, WorkflowSerializableValue>>;
		readonly source?: string;
		readonly argsHash: string;
		readonly ordinal: number;
		readonly startedAt: number;
	},
	error: unknown,
	attempts: number,
	cancelled = false,
): Promise<{ readonly message: string; readonly failedAt: number }> {
	await input.beforeCheckpoint?.();
	const message = workflowToolFailure(error, attempts, false).error.message;
	const failedAt = Date.now();
	await input.backend.commitAdditiveCheckpointBestEffort({
		kind: "tool",
		workflowId: input.workflowId,
		// The id counter restarts with each attempt; the attempt keeps a later attempt's failure from being dropped as
		// a repeat of an earlier one (#4874).
		checkpointId: `tool-failure:${identity.argsHash}:${attemptIdPart(input.backend, input.workflowId)}${input.nextCheckpointId()}`,
		name: identity.name,
		...(identity.args !== undefined ? { args: identity.args } : {}),
		...(identity.source !== undefined ? { source: identity.source } : {}),
		argsHash: identity.argsHash,
		output: null,
		throwingFailureError: message,
		...(cancelled ? { cancelled: true as const } : {}),
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

function attemptIdPart(backend: DurableWorkflowBackend, workflowId: string): string {
	const attempt = durableWorkflowAttempt(backend, workflowId);
	return attempt === undefined ? "" : `a${attempt}:`;
}

/**
 * Record, in the run's current attempt, the failed tool a resumed attempt had to reach first and ended without
 * reaching (#4874). The live run keeps that tool as it failed; recording it again keeps the durable view the same and
 * keeps the tool the frontier the next resume starts from. A run without attempts already shows it.
 */
export async function recordUnconsumedToolFrontier(
	backend: DurableWorkflowBackend,
	workflowId: string,
	argsHash: string,
): Promise<void> {
	const attempt = durableWorkflowAttempt(backend, workflowId);
	if (attempt === undefined) return;
	// A run's checkpoints are listed oldest first.
	const latest = backend
		.listCheckpoints(workflowId)
		.findLast((checkpoint) => checkpoint.kind === "tool" && checkpoint.argsHash === argsHash);
	if (latest?.kind !== "tool" || checkpointAttempt(latest) === attempt) return;
	const { attempt: _attempt, ...failure } = latest;
	await backend.commitAdditiveCheckpointBestEffort({
		...failure,
		checkpointId: `tool-failure:${argsHash}:a${attempt}:frontier`,
		completedAt: Date.now(),
	});
}
