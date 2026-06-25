/** Durable `ctx.stage` / `ctx.task` replay and checkpoint helpers. */

import type { StageContext, StageOptions, WorkflowTaskOptions, WorkflowTaskResult } from "../shared/types.js";
import type { StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableStageCheckpoint } from "./types.js";

export interface DurableStageDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextCheckpointId: () => string;
  readonly nextReplayKey: (stageName: string) => string;
  readonly replayKeyForCompletedStage?: (stage: StageSnapshot) => string | undefined;
}

export function recordStageCheckpoint(deps: DurableStageDeps, stage: StageSnapshot): boolean {
  if (stage.status !== "completed") return false;
  const replayKey = deps.replayKeyForCompletedStage?.(stage) ?? stage.replayKey ?? deps.nextReplayKey(stage.name);
  if (deps.backend.getStageOutput(deps.workflowId, replayKey) !== undefined) return false;
  const checkpoint: DurableStageCheckpoint = {
    kind: "stage",
    workflowId: deps.workflowId,
    checkpointId: stableCheckpointId("stage", replayKey),
    name: stage.name,
    replayKey,
    output: stageOutput(stage),
    completedAt: stage.endedAt ?? Date.now(),
  };
  deps.backend.recordCheckpoint(checkpoint);
  return true;
}

export function createDurableStagePrimitive(input: {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextReplayKey: (stageName: string) => string;
  readonly stage: (name: string, options: StageOptions | undefined, replayKey: string) => StageContext;
}): (name: string, options?: StageOptions) => StageContext {
  return (name: string, options?: StageOptions): StageContext => {
    const replayKey = input.nextReplayKey(name);
    const cached = input.backend.getStageOutput(input.workflowId, replayKey);
    if (cached !== undefined) return createCachedStageContext(name, cached);
    return input.stage(name, options, replayKey);
  };
}

export function createDurableTaskPrimitive(input: {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextReplayKey: (stageName: string) => string;
  readonly task: (name: string, options: WorkflowTaskOptions) => Promise<WorkflowTaskResult>;
}): (name: string, options: WorkflowTaskOptions) => Promise<WorkflowTaskResult> {
  return async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
    const replayKey = input.nextReplayKey(`task:${name}`);
    const cached = input.backend.getStageOutput(input.workflowId, replayKey);
    if (cached !== undefined && isWorkflowTaskResult(cached)) return cached;
    const result = await input.task(name, options);
    input.backend.recordCheckpoint({
      kind: "stage",
      workflowId: input.workflowId,
      checkpointId: stableCheckpointId("task", replayKey),
      name,
      replayKey,
      output: result,
      completedAt: Date.now(),
    });
    return result;
  };
}

function createCachedStageContext(name: string, output: WorkflowSerializableValue): StageContext {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const unsupported = async (): Promise<never> => { throw new Error(`Stage "${name}" was replayed from a durable checkpoint; live session operations are unavailable.`); };
  const cached = {
    name,
    async prompt() { return output as Awaited<ReturnType<StageContext["prompt"]>>; },
    async complete() { return text; },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    sessionFile: undefined,
    sessionId: `durable-replay:${name}`,
    setModel: unsupported,
    setThinkingLevel() {},
    cycleModel: unsupported,
    cycleThinkingLevel() { return undefined; },
    agent: undefined,
    model: undefined,
    thinkingLevel: undefined,
    messages: [],
    isStreaming: false,
    navigateTree: unsupported,
    compact: unsupported,
    abortCompaction() {},
    abort: async () => {},
  };
  return cached as never as StageContext;
}

function stageOutput(stage: StageSnapshot): WorkflowSerializableValue {
  if (stage.result !== undefined && stage.result.length > 0) return stage.result;
  return { status: stage.status, stageId: stage.id };
}

export function createStageReplayKeyGenerator(_workflowId: string): (stageName: string, stageId?: string) => string {
  const counts = new Map<string, number>();
  return (stageName: string, _stageId?: string): string => {
    const next = (counts.get(stageName) ?? 0) + 1;
    counts.set(stageName, next);
    return `stage:${stageName}:${next}`;
  };
}

export function stableCheckpointId(kind: string, replayKey: string): string {
  return `${kind}:${replayKey}`;
}

function isWorkflowTaskResult(value: WorkflowSerializableValue): value is WorkflowTaskResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as Record<string, WorkflowSerializableValue>)["text"] === "string";
}
