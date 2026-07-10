/** Durable `ctx.stage` / `ctx.task` replay and checkpoint helpers. */

import type { StageContext, StageOptions, WorkflowChildResult, WorkflowOutputValues, WorkflowTaskOptions, WorkflowTaskResult } from "../shared/types.js";
import type { StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { ParallelFailFastScope } from "../runs/foreground/executor-types.js";
import { durableHash } from "./backend.js";
import { recordCheckpointDurably } from "./tool-primitive.js";
import { RESUME_CONTINUATION_PROMPT } from "../shared/resume-continuation.js";
import type { DurableStageCheckpoint } from "./types.js";
export type DurableCompletedStageCheckpoint = DurableStageCheckpoint & { readonly output: WorkflowSerializableValue };

export interface DurableStageDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextCheckpointId: () => string;
  readonly nextReplayKey: (stageName: string) => string;
  readonly replayKeyForCompletedStage?: (stage: StageSnapshot) => string | undefined;
}

export async function recordStageCheckpoint(deps: DurableStageDeps, stage: StageSnapshot): Promise<boolean> {
  if (stage.status !== "completed") return false;
  const replayKey = deps.replayKeyForCompletedStage?.(stage) ?? stage.replayKey ?? deps.nextReplayKey(stage.name);
  const metadata = checkpointMetadata(stage);
  const hasExistingOutput = deps.backend.getStageOutput(deps.workflowId, replayKey) !== undefined;
  const checkpoint: DurableStageCheckpoint = hasExistingOutput
    ? {
        kind: "stage",
        workflowId: deps.workflowId,
        checkpointId: stageMetadataCheckpointId(replayKey, stage),
        name: stage.name,
        replayKey,
        completedAt: stage.endedAt ?? Date.now(),
        ...metadata,
      }
    : {
        kind: "stage",
        workflowId: deps.workflowId,
        checkpointId: stableCheckpointId("stage", replayKey),
        name: stage.name,
        replayKey,
        output: stageOutput(stage),
        completedAt: stage.endedAt ?? Date.now(),
        ...metadata,
      };
  await recordCheckpointDurably(deps.backend, checkpoint);
  return true;
}

export async function recordStageSessionCheckpoint(deps: DurableStageDeps, stage: StageSnapshot): Promise<boolean> {
  const replayKey = deps.replayKeyForCompletedStage?.(stage) ?? stage.replayKey ?? deps.nextReplayKey(stage.name);
  if (stage.sessionFile === undefined) return false;
  const current = deps.backend.getStageSession(deps.workflowId, replayKey);
  if (current?.sessionFile === stage.sessionFile) return false;
  const checkpoint: DurableStageCheckpoint = {
    kind: "stage",
    workflowId: deps.workflowId,
    checkpointId: stageSessionCheckpointId(replayKey, stage),
    name: stage.name,
    replayKey,
    ...(stage.sessionId !== undefined ? { sessionId: stage.sessionId } : {}),
    sessionFile: stage.sessionFile,
    completedAt: Date.now(),
  };
  await recordCheckpointDurably(deps.backend, checkpoint);
  return true;
}

const MID_SESSION_RESUME_PROMPT = RESUME_CONTINUATION_PROMPT;

function withMidSessionResumePrompt<T extends StageContext>(stage: T, enabled: boolean): T {
  if (!enabled) return stage;
  // Do NOT spread `stage` (e.g. `{ ...stage, prompt }`). The live StageContext
  // exposes lazy getters for `sessionId`/`sessionFile`/`messages`/`isStreaming`
  // that throw until the underlying SDK session has been created, and a spread
  // would eagerly read them before the first `prompt()` lands. Override
  // `prompt` in place instead — `prompt` is a normal configurable own property.
  const originalPrompt = stage.prompt.bind(stage);
  Object.defineProperty(stage, "prompt", {
    value: (_text: string, options?: Parameters<StageContext["prompt"]>[1]) =>
      originalPrompt(MID_SESSION_RESUME_PROMPT, options as never),
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return stage;
}


export function createDurableStagePrimitive(input: {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextReplayKey: (stageName: string) => string;
  readonly stage: (name: string, options: StageOptions | undefined, replayKey: string) => StageContext;
  readonly recordCachedStage?: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint) => void;
}): (name: string, options?: StageOptions) => StageContext {
  return (name: string, options?: StageOptions): StageContext => {
    const replayKey = input.nextReplayKey(name);
    const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey);
    if (cached !== undefined) {
      input.recordCachedStage?.(name, replayKey, cached);
      return createCachedStageContext(name, cached.output, cached.result);
    }
    const session = input.backend.getStageSession(input.workflowId, replayKey);
    const isMidSessionResume = session?.sessionFile !== undefined;
    const liveOptions: StageOptions | undefined = {
      ...(options ?? {}),
      durableReplayKey: replayKey,
      ...(isMidSessionResume ? { resumeFromSessionFile: session.sessionFile } : {}),
    };
    const live = withMidSessionResumePrompt(input.stage(name, liveOptions, replayKey), isMidSessionResume);
    if (options?.schema === undefined) return live;
    return wrapSchemaStageForDurability({
      stage: live,
      workflowId: input.workflowId,
      backend: input.backend,
      replayKey,
      name,
    });
  };
}

export function createDurableTaskPrimitive(input: {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextReplayKey: (stageName: string) => string;
  readonly task: (name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope) => Promise<WorkflowTaskResult>;
  readonly recordCachedTask?: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint, stageFailFastScope?: ParallelFailFastScope) => void;
}): (name: string, options: WorkflowTaskOptions) => Promise<WorkflowTaskResult> {
  return async (name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult> => {
    const replayKey = input.nextReplayKey(`task:${name}`);
    const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey, isWorkflowTaskResult);
    if (cached !== undefined && isWorkflowTaskResult(cached.output)) {
      input.recordCachedTask?.(name, replayKey, cached, stageFailFastScope);
      return cached.output;
    }
    const session = input.backend.getStageSession(input.workflowId, replayKey);
    const taskOptions: WorkflowTaskOptions = {
      ...options,
      durableReplayKey: replayKey,
      ...(session?.sessionFile !== undefined ? { resumeFromSessionFile: session.sessionFile } : {}),
    };
    const result = await input.task(name, taskOptions, stageFailFastScope);
    await recordCheckpointDurably(input.backend, {
      kind: "stage",
      workflowId: input.workflowId,
      checkpointId: stableCheckpointId("task", replayKey),
      name,
      replayKey,
      output: result,
      completedAt: Date.now(),
      ...taskCheckpointMetadata(result),
    });
    return result;
  };
}

function wrapSchemaStageForDurability(input: {
  readonly stage: StageContext;
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly replayKey: string;
  readonly name: string;
}): StageContext {
  const stage = input.stage;
  const wrapped = Object.create(stage) as StageContext;
  Object.defineProperty(wrapped, "prompt", {
    value: async (text: string, options?: Parameters<StageContext["prompt"]>[1]) => {
      const result = await stage.prompt(text, options);
      // Checkpoint both structured results AND empty string results so that
      // a schema-backed stage returning "" is replayed as "" rather than
      // being dropped (treated as no checkpoint).
      // cross-ref: issue #1498 — empty string stage outputs must survive durable checkpointing.
      if (typeof result !== "string" || result.length === 0) {
        await recordCheckpointDurably(input.backend, {
          kind: "stage",
          workflowId: input.workflowId,
          checkpointId: stableCheckpointId("stage", input.replayKey),
          name: input.name,
          replayKey: input.replayKey,
          output: result as WorkflowSerializableValue,
          completedAt: Date.now(),
        });
      }
      return result;
    },
  });
  return wrapped;
}

function createCachedStageContext(name: string, output: WorkflowSerializableValue, result?: string): StageContext {
  const text = result ?? (typeof output === "string" ? output : JSON.stringify(output));
  const unsupported = async (): Promise<never> => { throw new Error(`Stage "${name}" was replayed from a durable checkpoint; live session operations are unavailable.`); };
  const cached = {
    name,
    async prompt() { return output as Awaited<ReturnType<StageContext["prompt"]>>; },
    async complete() { return text; },
    sendUserMessage: unsupported,
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
  // Preserve empty string ("") distinctly from undefined (no result).
  // A stage that completed with empty assistant text must replay as empty,
  // not be collapsed into a status object.
  // cross-ref: issue #1498 — empty string stage outputs must survive durable checkpointing.
  if (stage.result !== undefined) return stage.result;
  return { status: stage.status, stageId: stage.id };
}

function checkpointMetadata(stage: StageSnapshot): Partial<DurableStageCheckpoint> {
  return {
    ...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
    ...(stage.endedAt !== undefined ? { endedAt: stage.endedAt } : {}),
    ...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
    ...(stage.result !== undefined ? { result: stage.result } : {}),
    ...(stage.sessionId !== undefined ? { sessionId: stage.sessionId } : {}),
    ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
    ...(stage.usage !== undefined ? { usage: stage.usage } : {}),
    ...(stage.usageComplete !== undefined ? { usageComplete: stage.usageComplete } : {}),
    ...(stage.model !== undefined ? { model: stage.model } : {}),
    ...(stage.fastMode !== undefined ? { fastMode: stage.fastMode } : {}),
    ...(stage.attemptedModels !== undefined ? { attemptedModels: [...stage.attemptedModels] } : {}),
    ...(stage.modelAttempts !== undefined ? { modelAttempts: [...stage.modelAttempts] } : {}),
  };
}

function taskCheckpointMetadata(result: WorkflowTaskResult): Partial<DurableStageCheckpoint> {
  return {
    result: result.text,
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.fastMode !== undefined ? { fastMode: result.fastMode } : {}),
    ...(result.attemptedModels !== undefined ? { attemptedModels: [...result.attemptedModels] } : {}),
    ...(result.modelAttempts !== undefined ? { modelAttempts: [...result.modelAttempts] } : {}),
  };
}

export function stageCheckpointWithOutput(
  backend: DurableWorkflowBackend,
  workflowId: string,
  replayKey: string,
  matchesOutput?: (value: WorkflowSerializableValue) => boolean,
): DurableCompletedStageCheckpoint | undefined {
  const checkpoints = backend.listCheckpoints(workflowId)
    .filter((checkpoint): checkpoint is DurableStageCheckpoint =>
      checkpoint.kind === "stage" && checkpoint.replayKey === replayKey,
    );
  const outputCheckpoints = checkpoints.filter((checkpoint): checkpoint is DurableCompletedStageCheckpoint =>
    checkpoint.output !== undefined,
  );
  const replayValueCheckpoint = matchesOutput === undefined
    ? outputCheckpoints[0]
    : outputCheckpoints.find((checkpoint) => matchesOutput(checkpoint.output));
  if (replayValueCheckpoint === undefined) return undefined;
  return mergeCheckpointHydrationMetadata(replayValueCheckpoint, checkpoints);
}

function mergeCheckpointHydrationMetadata(
  replayValueCheckpoint: DurableCompletedStageCheckpoint,
  checkpoints: readonly DurableStageCheckpoint[],
): DurableCompletedStageCheckpoint {
  if (checkpoints.length === 0) return replayValueCheckpoint;
  return {
    ...replayValueCheckpoint,
    ...(replayValueCheckpoint.startedAt === undefined ? metadataValue(checkpoints, "startedAt") : {}),
    ...(replayValueCheckpoint.endedAt === undefined ? metadataValue(checkpoints, "endedAt") : {}),
    ...(replayValueCheckpoint.durationMs === undefined ? metadataValue(checkpoints, "durationMs") : {}),
    ...(replayValueCheckpoint.result === undefined ? metadataValue(checkpoints, "result") : {}),
    ...(replayValueCheckpoint.sessionId === undefined ? metadataValue(checkpoints, "sessionId") : {}),
    ...(replayValueCheckpoint.sessionFile === undefined ? metadataValue(checkpoints, "sessionFile") : {}),
    ...(replayValueCheckpoint.model === undefined ? metadataValue(checkpoints, "model") : {}),
    ...(replayValueCheckpoint.fastMode === undefined ? metadataValue(checkpoints, "fastMode") : {}),
    ...(replayValueCheckpoint.attemptedModels === undefined ? metadataValue(checkpoints, "attemptedModels") : {}),
    ...(replayValueCheckpoint.modelAttempts === undefined ? metadataValue(checkpoints, "modelAttempts") : {}),
    ...(replayValueCheckpoint.usage === undefined ? metadataValue(checkpoints, "usage") : {}),
    ...(replayValueCheckpoint.usageComplete === undefined ? metadataValue(checkpoints, "usageComplete") : {}),
  };
}

function metadataValue<K extends keyof DurableStageCheckpoint>(
  checkpoints: readonly DurableStageCheckpoint[],
  key: K,
): Pick<DurableStageCheckpoint, K> | Record<string, never> {
  const value = checkpoints.find((checkpoint) => checkpoint[key] !== undefined)?.[key];
  return value === undefined ? {} : { [key]: value } as Pick<DurableStageCheckpoint, K>;
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

function stageSessionCheckpointId(replayKey: string, stage: StageSnapshot): string {
  return `${stableCheckpointId("stage-session", replayKey)}:${durableHash({
    sessionId: stage.sessionId ?? "",
    sessionFile: stage.sessionFile ?? "",
  })}`;
}

export function cachedStageId(runId: string, replayKey: string): string {
  return `durable-${durableHash({ runId, replayKey })}`;
}
function stageMetadataCheckpointId(replayKey: string, stage: StageSnapshot): string {
  return `${stableCheckpointId("stage-meta", replayKey)}:${durableHash({
    stageId: stage.id,
    endedAt: stage.endedAt ?? 0,
    durationMs: stage.durationMs ?? 0,
    result: stage.result ?? "",
  })}`;
}


export function recordCachedStageIntoStore(
  store: import("../shared/store.js").Store,
  runId: string,
  name: string,
  replayKey: string,
  output: WorkflowSerializableValue,
  completedStageReplayKeys: Map<string, string>,
  parentIds?: readonly string[],
  checkpoint?: DurableCompletedStageCheckpoint,
): void {
  const now = Date.now();
  const stageId = cachedStageId(runId, replayKey);
  const result = checkpoint?.result ?? (typeof output === "string" ? output : JSON.stringify(output));
  const endedAt = checkpoint?.endedAt ?? checkpoint?.completedAt ?? now;
  const workflowChild = isWorkflowChildResult(output) ? workflowChildSnapshotFromResult(output) : undefined;
  const snapshot: StageSnapshot = {
    id: stageId, name, status: "completed", parentIds: parentIds !== undefined ? Object.freeze([...parentIds]) : [],
    startedAt: checkpoint?.startedAt ?? endedAt, endedAt, durationMs: checkpoint?.durationMs ?? 0, result,
    replayKey, replayed: true, skippedReason: "durable checkpoint replay", toolEvents: [], attachable: false,
    ...(workflowChild !== undefined ? { workflowChild } : {}),
    ...(checkpoint?.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : {}),
    ...(checkpoint?.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : {}),
    ...(checkpoint?.model !== undefined ? { model: checkpoint.model } : {}),
    ...(checkpoint?.fastMode !== undefined ? { fastMode: checkpoint.fastMode } : {}),
    ...(checkpoint?.attemptedModels !== undefined ? { attemptedModels: checkpoint.attemptedModels } : {}),
    ...(checkpoint?.modelAttempts !== undefined ? { modelAttempts: checkpoint.modelAttempts } : {}),
    ...(checkpoint?.usage !== undefined ? { usage: checkpoint.usage } : {}),
    ...(checkpoint?.usageComplete !== undefined ? { usageComplete: checkpoint.usageComplete } : {}),
  };
  store.recordStageStart(runId, snapshot);
  store.recordStageEnd(runId, snapshot);
  completedStageReplayKeys.set(stageId, replayKey);
}

/**
 * Record a cached durable stage into the store AND register it in the graph
 * frontier tracker so parent/frontier lineage is preserved for subsequent stages.
 * cross-ref: issue #1498 — replayed durable stages preserve graph lineage.
 */
export function recordCachedStageWithTracker(
  store: import("../shared/store.js").Store,
  tracker: import("../engine/graph-inference.js").GraphFrontierTracker,
  runId: string,
  name: string,
  replayKey: string,
  checkpoint: DurableCompletedStageCheckpoint,
  completedStageReplayKeys: Map<string, string>,
  stageFailFastScope?: ParallelFailFastScope,
): void {
  const stageId = cachedStageId(runId, replayKey);
  let parentIds = tracker.onSpawn(stageId, name);
  const scopeParentIds = stageFailFastScope?.parentIds ?? [];
  if (stageFailFastScope !== undefined) {
    tracker.replaceParents(stageId, scopeParentIds);
    parentIds = [...scopeParentIds];
  }
  recordCachedStageIntoStore(store, runId, name, replayKey, checkpoint.output, completedStageReplayKeys, parentIds, checkpoint);
  tracker.onSettle(stageId);
}
function isWorkflowTaskResult(value: WorkflowSerializableValue): value is WorkflowTaskResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as Record<string, WorkflowSerializableValue>)["text"] === "string";
}

function isWorkflowChildResult(value: WorkflowSerializableValue): value is WorkflowChildResult<WorkflowOutputValues> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const objectValue = value as Record<string, WorkflowSerializableValue | undefined>;
  return typeof objectValue["workflow"] === "string"
    && typeof objectValue["runId"] === "string"
    && typeof objectValue["status"] === "string"
    && typeof objectValue["outputs"] === "object"
    && objectValue["outputs"] !== null
    && !Array.isArray(objectValue["outputs"]);
}

function workflowChildSnapshotFromResult(result: WorkflowChildResult<WorkflowOutputValues>): StageSnapshot["workflowChild"] {
  return {
    alias: result.workflow,
    workflow: result.workflow,
    runId: result.runId,
    status: result.status,
    ...(result.exited !== undefined ? { exited: result.exited } : {}),
    outputs: result.outputs,
    ...(typeof result.exitReason === "string" ? { exitReason: result.exitReason } : {}),
  };
}
