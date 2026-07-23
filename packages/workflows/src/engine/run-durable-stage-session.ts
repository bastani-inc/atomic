import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { recordStageSessionCheckpoint, type DurableStageDeps } from "../durable/stage-primitive.js";
import type { StageSessionCheckpointOptions } from "../runs/foreground/executor-types.js";
import { recordRunTimingCheckpoint } from "../durable/run-timing.js";

export interface DurableStageSessionRecorderInput {
  readonly runId: string;
  readonly deps: DurableStageDeps;
  readonly onStageSession?: (runId: string, snapshot: StageSnapshot, options?: StageSessionCheckpointOptions) => unknown;
  /**
   * Live root-run snapshot. When present, stage-session checkpoints also
   * refresh the debounced run-level elapsed record so a durable resume can
   * seed the total workflow duration. Omitted for child runs — run timing is
   * only tracked for the root workflow.
   */
  readonly runSnapshot?: RunSnapshot;
}

export function createDurableStageSessionRecorder(
  input: DurableStageSessionRecorderInput,
): (stageRunId: string, snapshot: StageSnapshot, options?: StageSessionCheckpointOptions) => Promise<void> {
  return async (stageRunId, snapshot, options) => {
    if (stageRunId === input.runId) {
      await recordStageSessionCheckpoint(input.deps, snapshot, { force: options?.forceDurable === true });
      if (input.runSnapshot !== undefined) {
        recordRunTimingCheckpoint(input.deps.backend, input.runSnapshot, { debounce: options?.forceDurable !== true });
      }
    }
    await input.onStageSession?.(stageRunId, snapshot, options);
  };
}
