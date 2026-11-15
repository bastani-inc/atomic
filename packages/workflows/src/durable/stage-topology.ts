import type { StageSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageRunTopology,
	type DurableStageTopology,
} from "./types.js";

/**
 * The suffix of a fork's record of its fork point's place in the graph (#5042), under the stage's replay key so a stage in
 * a child workflow keeps the record in the child's scope. A run-level record: it names no graph node of its own.
 */
export const FORK_POINT_CHECKPOINT_SUFFIX = ":fork-point-topology";

/** The key of the fork point record of the stage at `replayKey`. */
export function forkPointCheckpointKey(replayKey: string): string {
	return `${replayKey}${FORK_POINT_CHECKPOINT_SUFFIX}`;
}

/**
 * The stage id, parents and source order a fork's source recorded for its fork point (#5042), as the topology the stage
 * resumes with. The fork's events end before the fork point's first record; without these, the stage would take the
 * frontier the fork has when it is created, which can hold a stage that ran beside it, and the place in the run's stages
 * of a replayed sibling that sorted ahead of it.
 */
export function forkPointStageTopology(
	backend: DurableWorkflowBackend,
	workflowId: string,
	replayKey: string,
): DurableStageTopology | undefined {
	const output = backend.getToolCheckpoint(workflowId, forkPointCheckpointKey(replayKey))?.output;
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const { stageId, parentIds, sourceOrder } = output as {
		readonly stageId?: unknown;
		readonly parentIds?: unknown;
		readonly sourceOrder?: unknown;
	};
	if (typeof stageId !== "string" || !Array.isArray(parentIds) || !parentIds.every((id) => typeof id === "string"))
		return undefined;
	return {
		version: DURABLE_STAGE_TOPOLOGY_VERSION,
		stageId,
		parentIds: [...parentIds],
		...(typeof sourceOrder === "number" ? { sourceOrder } : {}),
		status: "pending",
	};
}

/** Find source identity for the latest active session at an exact replay key. */
export function activeStageTopology(
	backend: DurableWorkflowBackend,
	workflowId: string,
	replayKey: string,
): DurableStageTopology | undefined {
	const checkpoints = backend.listCheckpoints(workflowId);
	for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
		const checkpoint = checkpoints[index];
		if (checkpoint?.kind !== "stage" || checkpoint.replayKey !== replayKey) continue;
		const topology = checkpoint.topology;
		if (topology !== undefined && (topology.run === undefined || topology.run.runId === workflowId)) return topology;
	}
	return undefined;
}

export function durableStageCheckpointMetadata(
	stage: StageSnapshot,
	run?: DurableStageRunTopology,
	sourceOrder?: number,
): Partial<DurableStageCheckpoint> {
	return {
		topology: {
			version: DURABLE_STAGE_TOPOLOGY_VERSION,
			stageId: stage.id,
			parentIds: [...stage.parentIds],
			...(stage.intercomGroup !== undefined ? { intercomGroup: stage.intercomGroup } : {}),
			...(stage.executionOrder !== undefined ? { order: stage.executionOrder } : {}),
			...(sourceOrder !== undefined && sourceOrder >= 0 ? { sourceOrder } : {}),
			...(stage.promptFootprint !== undefined ? { occurrenceKey: stage.id } : {}),
			status: stage.status,
			...(run !== undefined ? { run: { ...run } } : {}),
		},
		...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
		...(stage.endedAt !== undefined ? { endedAt: stage.endedAt } : {}),
		...(stage.result !== undefined ? { result: stage.result } : {}),
		...(stage.sessionId !== undefined ? { sessionId: stage.sessionId } : {}),
		...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
		...(stage.sessionStorage === "stage" ? { sessionStorage: "stage" as const } : {}),
		...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
		...(stage.model !== undefined ? { model: stage.model } : {}),
		...(stage.thinkingLevel !== undefined ? { thinkingLevel: stage.thinkingLevel } : {}),
		...(stage.attemptedModels !== undefined ? { attemptedModels: [...stage.attemptedModels] } : {}),
		...(stage.modelAttempts !== undefined ? { modelAttempts: [...stage.modelAttempts] } : {}),
		...(stage.rateLimits !== undefined ? { rateLimits: [...stage.rateLimits] } : {}),
		...(stage.routerSelection !== undefined ? { routerSelection: stage.routerSelection } : {}),
		...(stage.structured !== undefined ? { structured: stage.structured } : {}),
		...(stage.artifacts !== undefined ? { artifacts: [...stage.artifacts] } : {}),
		...(stage.warnings !== undefined ? { warnings: [...stage.warnings] } : {}),
		...(stage.wait !== undefined ? { wait: stage.wait } : {}),
		...(stage.waitResults !== undefined ? { waitResults: stage.waitResults } : {}),
	};
}
