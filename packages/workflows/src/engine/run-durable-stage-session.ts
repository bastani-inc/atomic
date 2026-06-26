import type { StageSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { persistDurableCacheEntry } from "../durable/resume-catalog.js";
import { recordStageSessionCheckpoint, type DurableStageDeps } from "../durable/stage-primitive.js";

export interface DurableStageSessionRecorderInput {
  readonly runId: string;
  readonly deps: DurableStageDeps;
  readonly backend: DurableWorkflowBackend;
  readonly persistence?: WorkflowPersistencePort;
  readonly onStageSession?: (runId: string, snapshot: StageSnapshot) => unknown;
}

export function createDurableStageSessionRecorder(
  input: DurableStageSessionRecorderInput,
): (stageRunId: string, snapshot: StageSnapshot) => void {
  return (stageRunId, snapshot) => {
    if (stageRunId === input.runId) {
      void recordStageSessionCheckpoint(input.deps, snapshot).then((recorded) => {
        if (!recorded || !input.persistence || !input.backend.persistent) return;
        const cacheEntry = input.backend.toCacheEntry(input.runId);
        if (cacheEntry) persistDurableCacheEntry(input.persistence, cacheEntry);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`atomic-workflows: durable stage session checkpoint failed: ${message}`);
      });
    }
    void input.onStageSession?.(stageRunId, snapshot);
  };
}
