import { recordRunTimingCheckpointAsync } from "../durable/run-timing.js";
import { type DurableStageDeps, recordStageSessionCheckpoint } from "../durable/stage-primitive.js";
import { recordWorkflowHeartbeatAnchor } from "../durable/workflow-heartbeat-anchor.js";
import type { StageSessionCheckpointOptions } from "../runs/foreground/executor-types.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";

export interface DurableStageSessionRecorderInput {
	readonly runId: string;
	readonly deps: DurableStageDeps;
	readonly onStageSession?: (
		runId: string,
		snapshot: StageSnapshot,
		options?: StageSessionCheckpointOptions,
	) => unknown;
	/**
	 * Live root-run snapshot. When present, stage-session checkpoints also
	 * refresh the debounced run-level elapsed record so a durable resume can
	 * seed the total workflow duration. Omitted for child runs — run timing is
	 * only tracked for the root workflow.
	 */
	readonly runSnapshot?: RunSnapshot;
	/** Cadence declared by the live definition that minted `runSnapshot`. */
	readonly heartbeatIntervalMinutes: number;
}

export function createDurableStageSessionRecorder(
	input: DurableStageSessionRecorderInput,
): (stageRunId: string, snapshot: StageSnapshot, options?: StageSessionCheckpointOptions) => Promise<void> {
	return async (stageRunId, snapshot, options) => {
		if (stageRunId === input.runId) {
			await recordStageSessionCheckpoint(input.deps, snapshot, { force: options?.forceDurable === true });
			if (input.runSnapshot !== undefined) {
				await recordRunTimingCheckpointAsync(input.deps.backend, input.runSnapshot, {
					debounce: options?.forceDurable !== true,
				});
				// Any checkpoint above can be the first one that makes the run
				// resumable, and the scheduler's own launch-record write is
				// asynchronous and best-effort: it is guarded against runs with no
				// durable progress, so it can only be issued *after* resumability
				// already exists. A process that exits inside that window leaves a
				// resumable run with no record of what it launched with, and the next
				// process then reads a freshly minted `startedAt` and whatever cadence
				// the definition currently declares — shifting both phase and cadence
				// under a run already in flight.
				//
				// Awaiting the write here closes that window: the record is durable
				// before this checkpoint is acknowledged to its caller. It is
				// write-once and returns early once present, so later passes cost one
				// mirror read. A forced pause/quit capture additionally has no further
				// active schedule pass to retry in, which is why this must not be
				// limited to the ordinary path either.
				const intervalMinutes = input.heartbeatIntervalMinutes;
				if (Number.isFinite(intervalMinutes * 60_000)) {
					await recordWorkflowHeartbeatAnchor(input.deps.backend, {
						runId: input.runId,
						anchorAt: input.runSnapshot.startedAt,
						intervalMinutes,
						now: input.deps.now?.() ?? Date.now(),
					});
				}
			}
		}
		await input.onStageSession?.(stageRunId, snapshot, options);
	};
}
