import type { StageSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageRunTopology,
	type DurableStageTopology,
} from "./types.js";

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
		...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
		...(stage.model !== undefined ? { model: stage.model } : {}),
		...(stage.fastMode !== undefined ? { fastMode: stage.fastMode } : {}),
		...(stage.attemptedModels !== undefined ? { attemptedModels: [...stage.attemptedModels] } : {}),
		...(stage.modelAttempts !== undefined ? { modelAttempts: [...stage.modelAttempts] } : {}),
	};
}
