/**
 * Durable `ctx.stage` / `ctx.task` checkpoint recorder.
 *
 * Records completed stage outputs as durable {@link DurableStageCheckpoint}
 * records so a cross-session resume can skip re-running stages whose output is
 * already cached. The replay key mirrors the engine's continuation replay
 * identity so durable replay aligns with the existing in-process replay index.
 *
 * Recording happens at the stage-end lifecycle boundary (via `onStageEnd`),
 * which is the natural durable checkpoint surface: a stage that reached
 * `completed` has produced its output and side effects and is safe to cache.
 *
 * cross-ref: issue #1498 — "Wire durable checkpoints for ctx.stage/ctx.task
 * outputs at actual lifecycle boundaries."
 */

import type { StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableStageCheckpoint } from "./types.js";

/**
 * Dependencies required to record durable stage checkpoints.
 */
export interface DurableStageDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  /** Monotonic checkpoint id counter source. */
  readonly nextCheckpointId: () => string;
  /** Replay-key generator (matches engine continuation replay semantics). */
  readonly nextReplayKey: (stageName: string, stageId: string) => string;
}

/**
 * Record a completed stage's output durably. No-op for non-completed stages,
 * since only completed stages have stable outputs worth caching.
 *
 * Returns true when a checkpoint was recorded, false otherwise.
 */
export function recordStageCheckpoint(deps: DurableStageDeps, stage: StageSnapshot): boolean {
  if (stage.status !== "completed") return false;
  // Prefer the stage's own replayKey when present (continuation-aligned);
  // otherwise derive one from the stage identity so resume replay is stable.
  const replayKey = stage.replayKey ?? deps.nextReplayKey(stage.name, stage.id);
  // Skip if already cached — the backend is idempotent, but avoiding a redundant
  // write keeps the pending-prompt/session metadata untouched.
  if (deps.backend.getStageOutput(deps.workflowId, replayKey) !== undefined) return false;
  const output = stageOutput(stage);
  const checkpoint: DurableStageCheckpoint = {
    kind: "stage",
    workflowId: deps.workflowId,
    checkpointId: deps.nextCheckpointId(),
    name: stage.name,
    replayKey,
    output,
    completedAt: stage.endedAt ?? Date.now(),
  };
  deps.backend.recordCheckpoint(checkpoint);
  return true;
}

/**
 * Resolve the serializable output for a stage checkpoint. Prefers the stage's
 * recorded `result` text; falls back to a minimal status marker so the
 * checkpoint still exists for replay-skip decisions.
 */
function stageOutput(stage: StageSnapshot): WorkflowSerializableValue {
  if (stage.result !== undefined && stage.result.length > 0) return stage.result;
  return { status: stage.status, stageId: stage.id };
}

/**
 * Build a stable replay-key generator scoped to a workflow run. Replay keys are
 * namespaced by workflow id + stage name + ordinal so two stages sharing a name
 * do not collide.
 */
export function createStageReplayKeyGenerator(workflowId: string): (stageName: string, stageId: string) => string {
  const counts = new Map<string, number>();
  return (stageName: string, stageId: string): string => {
    const next = (counts.get(stageName) ?? 0) + 1;
    counts.set(stageName, next);
    return `durable:${workflowId}:${stageName}:${next}:${stageId.slice(0, 8)}`;
  };
}
