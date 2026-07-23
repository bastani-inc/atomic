import { durableHash, type DurableWorkflowBackend } from "../durable/backend.js";
import { durableNestedRunSnapshots } from "../durable/completed-catalog.js";
import {
  durableStageCheckpointMetadata,
  recordCachedStageWithTracker,
  type DurableCompletedStageCheckpoint,
  type DurableStageDeps,
} from "../durable/stage-primitive.js";
import type { DurableStageRunTopology } from "../durable/types.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { Store } from "../shared/store.js";
import type { ParallelFailFastScope } from "../runs/foreground/executor-types.js";

export function durableRunTopology(run: RunSnapshot): DurableStageRunTopology {
  return {
    runId: run.id,
    runName: run.name,
    ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
    ...(run.parentStageId !== undefined ? { parentStageId: run.parentStageId } : {}),
    ...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
  };
}

export function createDurableStageDeps(input: {
  readonly backend: DurableWorkflowBackend;
  readonly run: RunSnapshot;
  readonly nextCheckpointId: () => string;
  readonly nextReplayKey: (stageName: string) => string;
  readonly completedReplayKeys: Map<string, string>;
}): DurableStageDeps {
  return {
    workflowId: input.run.id,
    backend: input.backend,
    nextCheckpointId: input.nextCheckpointId,
    nextReplayKey: input.nextReplayKey,
    replayKeyForCompletedStage: (stage) => input.completedReplayKeys.get(stage.id),
    runTopology: durableRunTopology(input.run),
  };
}

export function createDurableCachedStageRecorder(input: {
  readonly store: Store;
  readonly tracker: GraphFrontierTracker;
  readonly run: RunSnapshot;
  readonly backend: DurableWorkflowBackend;
  readonly rootBackend: DurableWorkflowBackend;
  readonly completedStageReplayKeys: Map<string, string>;
}): {
  readonly record: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint, scope?: ParallelFailFastScope) => void;
  readonly metadata: (replayKey: string) => Partial<DurableCompletedStageCheckpoint>;
} {
  return {
    record(name, replayKey, checkpoint, scope): void {
      recordCachedStageWithTracker(
        input.store, input.tracker, input.run.id, name, replayKey, checkpoint,
        input.completedStageReplayKeys, scope,
      );
      const stage = input.store.runs().find((run) => run.id === input.run.id)?.stages
        .find((candidate) => candidate.replayKey === replayKey);
      if (stage !== undefined) {
        input.backend.recordCheckpoint({
          kind: "stage", workflowId: input.run.id,
          checkpointId: `stage-replay-meta:${durableHash({ replayKey, stageId: stage.id, parentIds: stage.parentIds })}`,
          name, replayKey, completedAt: Date.now(),
          ...durableStageCheckpointMetadata(stage, durableRunTopology(input.run)),
        });
      }
      if (workflowChildRunId(checkpoint) === undefined) return;
      const durableRootId = input.run.rootRunId ?? input.run.id;
      for (const childRun of durableNestedRunSnapshots(input.rootBackend, durableRootId)) {
        if (!input.store.runs().some((candidate) => candidate.id === childRun.id)) input.store.recordRunStart(childRun);
      }
    },
    metadata(replayKey) {
      const stage = input.run.stages.find((candidate) => candidate.replayKey === replayKey);
      return stage === undefined ? {} : durableStageCheckpointMetadata(stage, durableRunTopology(input.run));
    },
  };
}

function workflowChildRunId(checkpoint: DurableCompletedStageCheckpoint): string | undefined {
  const output = checkpoint.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const record = output as Record<string, import("../shared/types.js").WorkflowSerializableValue>;
  const runId = record["runId"];
  const workflow = record["workflow"];
  return typeof runId === "string" && typeof workflow === "string" ? runId : undefined;
}
