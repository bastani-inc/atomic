import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { recordStageSessionCheckpoint, type DurableStageDeps } from "../durable/stage-primitive.js";
import { recordRunTimingCheckpoint } from "../durable/run-timing.js";

export interface DurableStageSessionRecorderInput {
  readonly runId: string;
  readonly deps: DurableStageDeps;
  readonly onStageSession?: (runId: string, snapshot: StageSnapshot) => unknown;
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
): (stageRunId: string, snapshot: StageSnapshot) => void {
  return (stageRunId, snapshot) => {
    if (stageRunId === input.runId) {
      void recordStageSessionCheckpoint(input.deps, snapshot).then(() => {
        if (input.runSnapshot !== undefined) {
          recordRunTimingCheckpoint(input.deps.backend, input.runSnapshot, { debounce: true });
        }
      }).catch(() => {});
    }
    void input.onStageSession?.(stageRunId, snapshot);
  };
}
