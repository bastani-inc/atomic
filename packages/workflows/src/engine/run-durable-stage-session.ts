import type { StageSnapshot } from "../shared/store-types.js";
import { recordStageSessionCheckpoint, type DurableStageDeps } from "../durable/stage-primitive.js";

export interface DurableStageSessionRecorderInput {
  readonly runId: string;
  readonly deps: DurableStageDeps;
  readonly onStageSession?: (runId: string, snapshot: StageSnapshot) => unknown;
}

export function createDurableStageSessionRecorder(
  input: DurableStageSessionRecorderInput,
): (stageRunId: string, snapshot: StageSnapshot) => void {
  return (stageRunId, snapshot) => {
    if (stageRunId === input.runId) {
      void recordStageSessionCheckpoint(input.deps, snapshot);
    }
    void input.onStageSession?.(stageRunId, snapshot);
  };
}
