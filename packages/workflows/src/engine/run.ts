import { nextEventLoopTurn, runWorkflowDefinitionCallback } from "./workflow-activity.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues, WorkflowRunContext } from "../shared/types.js";
import type { WorkflowFailure } from "../shared/workflow-failures.js";
import { classifyWorkflowFailure } from "../shared/workflow-failures.js";
import { store as defaultStore } from "../shared/store.js";
import { appendRunStart } from "../shared/persistence-session-entries.js";
import { GraphFrontierTracker } from "./graph-inference.js";
import { EngineRuntime } from "./runtime.js";
import type { EngineChildRunOptions, EngineStageRuntimeOptions, EngineWorkflowBoundaryOptions } from "./options.js";
import { createContinuationReplayIndex } from "./replay.js";
import { buildExitGatedUiContext } from "./primitives/ui.js";
import { createWorkflowExitManager } from "./primitives/exit.js";
import { createWorkflowTaskRunners } from "./primitives/task.js";
import { createChildWorkflowRunner } from "./primitives/workflow.js";
import { createChainPrimitive } from "./primitives/chain.js";
import { createParallelPrimitive } from "./primitives/parallel.js";
import { createRunLimiter } from "../runs/shared/concurrency.js";
import { stageControlRegistry as defaultStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import { unknownErrorMessage, findWorkflowExitSignal, parentWorkflowExitAbortReason } from "../runs/foreground/executor-abort.js";
import { resolveAndValidateInputs, resolveInputConcurrency, resolveInputRuntimeDefaults } from "../runs/foreground/executor-inputs.js";
import { createGitWorktreeSetupCacheOwner, workflowCwdWithInputWorktree, workflowInvocationMetadata } from "../runs/foreground/executor-direct-helpers.js";
import { createStageScheduler } from "../runs/foreground/executor-scheduler.js";
import { createRunFinalizers } from "../runs/foreground/executor-run-finalizers.js";
import { buildPromptNodeUiAdapter } from "../runs/foreground/executor-prompt-nodes.js";
import {
  appendRunEndWhenRecorded,
  assertWorkflowCreatedStage,
  finalizeKilled,
  finalizeKilledByFailure,
  recordActiveBlockedFailure,
  reconcileTerminalRunResult,
  selectRunFailureDisposition,
} from "../runs/foreground/executor-lifecycle.js";
import { assertWorkflowRunOutputs, normalizeWorkflowRunOutput } from "../runs/foreground/executor-outputs.js";
import { isWorkflowDefinition, workflowDefinitionRequirementMessage } from "../runs/foreground/executor-child-helpers.js";
import { getDurableBackend } from "../durable/factory.js";
import { classifyReturnedRunStatus } from "./run-returned-status.js";
import { createToolPrimitive, createCheckpointIdGenerator } from "../durable/tool-primitive.js";
import { persistDurableCacheEntry } from "../durable/resume-catalog.js";
import { createDurableStagePrimitive, createDurableTaskPrimitive, recordStageCheckpoint, createStageReplayKeyGenerator, recordCachedStageWithTracker } from "../durable/stage-primitive.js";
import type { DurableCompletedStageCheckpoint } from "../durable/stage-primitive.js";
import { createDurableChildWorkflowPrimitive } from "../durable/child-primitive.js";
import { ScopedDurableBackend, type DurableScope } from "../durable/scoped-backend.js";
import { finalizeDurableTerminalStatus } from "./run-durable-finalize.js";
import { createDurableStageSessionRecorder } from "./run-durable-stage-session.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";

type WorkflowRunInputArgument = Parameters<typeof resolveAndValidateInputs>[1];

export function run<
  TInputs extends WorkflowInputValues,
  TOutputs extends WorkflowOutputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  def: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
  inputs: WorkflowRunInputArgument,
  opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
export async function run<
  TInputs extends WorkflowInputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
  inputs: WorkflowRunInputArgument,
  opts: RunOpts = {},
): Promise<RunResult> {
  if (!isWorkflowDefinition(def)) throw new Error(workflowDefinitionRequirementMessage("run(definition, inputs)", def));

  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};
  // Prompt-node UI is the graph-mode transport and intentionally takes precedence
  // over an injected RunOpts.ui adapter; warn because that adapter will be ignored.
  if (opts.usePromptNodesForUi === true && opts.ui !== undefined) {
    console.warn("atomic-workflows: usePromptNodesForUi ignores the provided RunOpts.ui adapter");
  }

  const depth = opts.depth ?? 0;
  const maxDepth = opts.config?.maxDepth ?? 4;
  if (depth >= maxDepth) {
    return {
      runId: opts.runId ?? crypto.randomUUID(),
      status: "failed",
      error: `atomic-workflows: maxDepth exceeded (max ${maxDepth})`,
      stages: [],
    };
  }

  const resolvedInputs = resolveAndValidateInputs(def.inputs, inputs, `workflow "${def.name}"`);
  const runId = opts.runId ?? crypto.randomUUID();
  const exitScope = Symbol(`workflow-exit:${runId}`);
  const ownController = new AbortController();
  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) ownController.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", () => { ownController.abort(callerSignal.reason); }, { once: true });
  }
  const exit = createWorkflowExitManager({ runId, exitScope, controller: ownController });

  const runSnapshot: RunSnapshot = {
    id: runId,
    name: def.name,
    inputs: Object.freeze(resolvedInputs),
    status: "running" as const,
    stages: [],
    startedAt: Date.now(),
    ...(opts.parentRun !== undefined ? {
      parentRunId: opts.parentRun.runId,
      parentStageId: opts.parentRun.stageId,
      rootRunId: opts.parentRun.rootRunId,
    } : {}),
    ...(opts.continuation !== undefined ? {
      resumedFromRunId: opts.continuation.source.id,
      resumeFromStageId: opts.continuation.resumeFromStageId,
    } : {}),
  };

  const classifiedFailures = new Map<unknown, WorkflowFailure>();
  const classifyExecutorFailure = (error: unknown): WorkflowFailure => {
    const cached = classifiedFailures.get(error);
    if (cached !== undefined) return cached;
    let classified: WorkflowFailure;
    try {
      classified = classifyWorkflowFailure(error);
    } catch {
      classified = classifyWorkflowFailure(new Error(unknownErrorMessage(error)));
    }
    classifiedFailures.set(error, classified);
    return classified;
  };

  activeStore.recordRunStart(runSnapshot);
  if (!opts.signal) opts.cancellation?.register(runId, ownController);
  opts.onRunStart?.(runSnapshot);
  if (opts.persistence) {
    appendRunStart(opts.persistence, {
      runId,
      name: def.name,
      inputs: resolvedInputs,
      ...(runSnapshot.parentRunId !== undefined ? { parentRunId: runSnapshot.parentRunId } : {}),
      ...(runSnapshot.parentStageId !== undefined ? { parentStageId: runSnapshot.parentStageId } : {}),
      ...(runSnapshot.rootRunId !== undefined ? { rootRunId: runSnapshot.rootRunId } : {}),
      ...(runSnapshot.resumedFromRunId !== undefined ? { resumedFromRunId: runSnapshot.resumedFromRunId } : {}),
      ...(runSnapshot.resumeFromStageId !== undefined ? { resumeFromStageId: runSnapshot.resumeFromStageId } : {}),
      ts: runSnapshot.startedAt,
    });
  }

  const tracker = new GraphFrontierTracker();
  const inputConcurrency = resolveInputConcurrency(def.inputs, resolvedInputs);
  const inputRuntimeDefaults = resolveInputRuntimeDefaults(def, resolvedInputs), gitWorktreeSetupCacheOwner = createGitWorktreeSetupCacheOwner(opts.gitWorktreeSetupCache);
  const gitWorktreeSetupCache = gitWorktreeSetupCacheOwner.cache;
  const workflowInvocationCwd = opts.cwd ?? process.cwd();
  let workflowCwd: string | undefined;
  const resolveWorkflowCwd = (): string => {
    workflowCwd ??= workflowCwdWithInputWorktree(inputRuntimeDefaults, workflowInvocationCwd, gitWorktreeSetupCache);
    return workflowCwd;
  };
  const limiter = createRunLimiter(inputConcurrency ?? opts.config?.defaultConcurrency);
  const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
  const replayIndex = createContinuationReplayIndex(opts.continuation);
  const scheduler = createStageScheduler({
    runId,
    runSnapshot,
    activeStore,
    tracker,
    stageRegistry: () => stageRegistry,
  });
  ownController.signal.addEventListener(
    "abort",
    () => scheduler.rejectReleaseBarriers(ownController.signal.reason ?? new Error("atomic-workflows: run aborted")),
    { once: true },
  );

  const finalizers = createRunFinalizers({
    def,
    runId,
    runSnapshot,
    activeStore,
    opts,
    classifyExecutorFailure,
    drainWorkflowExitCleanups: exit.drainWorkflowExitCleanups,
  });
  // Durable workflow backend — registers this run and wires ctx.tool/ui/stage.
  // Declared early so the stage-end recorder can attach to stageOptions.
  // cross-ref: issue #1498 — DBOS-backed cross-session resumability.
  // Child runs with a durable scope route their internal side-effect
  // checkpoints under the root workflow so interrupted children do not
  // re-execute completed side effects on parent resume.
  const rootBackend: DurableWorkflowBackend = opts.durableBackend ?? getDurableBackend();
  const durableBackend: DurableWorkflowBackend = opts.durableScope !== undefined
    ? new ScopedDurableBackend(rootBackend, opts.durableScope)
    : rootBackend;
  const checkpointIdGenerator = createCheckpointIdGenerator();
  const stageReplayKeyGenerator = createStageReplayKeyGenerator(runId);
  const completedStageReplayKeys = new Map<string, string>();
  const durableStageDeps = {
    workflowId: runId,
    backend: durableBackend,
    nextCheckpointId: checkpointIdGenerator,
    nextReplayKey: stageReplayKeyGenerator,
    replayKeyForCompletedStage: (stage: StageSnapshot) => completedStageReplayKeys.get(stage.id),
  };
  const userOnStageEnd = opts.onStageEnd;
  const durableOnStageEnd = async (stageRunId: string, snapshot: StageSnapshot): Promise<void> => {
    if (stageRunId === runId && snapshot.status === "completed") {
      await recordStageCheckpoint(durableStageDeps, snapshot);
      if (opts.persistence && durableBackend.persistent) {
        const cacheEntry = durableBackend.toCacheEntry(runId);
        if (cacheEntry) persistDurableCacheEntry(opts.persistence, cacheEntry);
      }
    }
    await userOnStageEnd?.(stageRunId, snapshot);
  };
  const durableOnStageSession = createDurableStageSessionRecorder({ runId, deps: durableStageDeps, backend: durableBackend, persistence: opts.persistence, onStageSession: opts.onStageSession });
  const stageOptions: EngineStageRuntimeOptions = {
    continuation: opts.continuation,
    models: opts.models,
    executionMode: opts.executionMode,
    defaultSessionDir: opts.defaultSessionDir,
    persistence: opts.persistence,
    onStageStart: opts.onStageStart,
    onStageEnd: durableOnStageEnd,
    onStageSession: durableOnStageSession,
    confirmStageReadiness: opts.confirmStageReadiness,
    usePromptNodesForUi: opts.usePromptNodesForUi,
  };
  const workflowBoundaryOptions: EngineWorkflowBoundaryOptions = {
    persistence: opts.persistence,
    onStageStart: opts.onStageStart,
    onStageEnd: opts.onStageEnd,
  };
  const childRunOptions: EngineChildRunOptions = {
    adapters: opts.adapters,
    ui: opts.ui,
    executionMode: opts.executionMode,
    defaultSessionDir: opts.defaultSessionDir,
    usePromptNodesForUi: opts.usePromptNodesForUi,
    confirmStageReadiness: opts.confirmStageReadiness,
    store: opts.store,
    persistence: opts.persistence,
    mcp: opts.mcp,
    cancellation: opts.cancellation,
    overlay: opts.overlay,
    config: opts.config,
    models: opts.models,
    registry: opts.registry,
    stageControlRegistry: opts.stageControlRegistry,
    onStageStart: opts.onStageStart,
    onStageEnd: opts.onStageEnd,
    onStageSession: opts.onStageSession,
    durableBackend,
  };
  const runtime = new EngineRuntime({
    runId,
    depth,
    runSnapshot,
    activeStore,
    stageOptions,
    workflowBoundaryOptions,
    childRunOptions,
    parentRootRunId: opts.parentRun?.rootRunId,
    adapters,
    signal: ownController.signal,
    tracker,
    scheduler,
    replayIndex,
    limiter,
    inputRuntimeDefaults,
    workflowInvocationCwd,
    stageRegistry, gitWorktreeSetupCache,
    exit,
    classifyExecutorFailure,
  });
  const workflowBoundaryReplayCounts = new Map<string, number>();
  const nextWorkflowBoundaryReplayKey = (name: string): string => {
    const durableScopePrefix = pendingChildDurableScope?.scopePrefix;
    if (durableScopePrefix !== undefined && durableScopePrefix.startsWith(`workflow:${name}:`)) return durableScopePrefix;
    const next = (workflowBoundaryReplayCounts.get(name) ?? 0) + 1;
    workflowBoundaryReplayCounts.set(name, next);
    return `workflow:${name}:${next}`;
  };
  // Durable child workflow replay keys use a SEPARATE counter so that cache
  // hits (which do not invoke the inner workflow runner) do not desync the
  // ordinal sequence. Without this, repeated ctx.workflow(child) calls would
  // shift replay keys on resume and re-execute completed children.
  // cross-ref: issue #1498.
  const durableChildReplayCounts = new Map<string, number>();
  const nextDurableChildReplayKey = (name: string): string => {
    const next = (durableChildReplayCounts.get(name) ?? 0) + 1;
    durableChildReplayCounts.set(name, next);
    return `workflow:${name}:${next}`;
  };
  const taskRunners = createWorkflowTaskRunners({ runtime });
  // Durable scope holder: the durable child primitive publishes the scope for
  // the next child invocation; the child runner consumes it when launching the
  // run. This routes child internal side-effect checkpoints under the root.
  let pendingChildDurableScope: DurableScope | undefined;
  const workflow = createChildWorkflowRunner({
    runtime,
    resolveWorkflowCwd,
    nextWorkflowBoundaryReplayKey,
    consumeDurableScope: () => {
      const scope = pendingChildDurableScope;
      pendingChildDurableScope = undefined;
      return scope;
    },
    runWorkflow: run,
  });
  const durableRootWorkflowRegistration = {
    workflowId: runId,
    name: def.name,
    inputs: resolvedInputs as Record<string, import("../shared/types.js").WorkflowSerializableValue>,
    createdAt: runSnapshot.startedAt,
    status: "running" as const,
    rootWorkflowId: runId,
    resumable: true,
    ...(opts.persistence !== undefined ? { sessionFile: undefined } : {}),
  };
  if (opts.continuation === undefined && opts.parentRun === undefined) {
    durableBackend.registerWorkflow({ ...durableRootWorkflowRegistration, invocationCwd: workflowInvocationCwd });
  } else if (opts.parentRun === undefined) {
    durableBackend.setWorkflowStatus(runId, "running");
  }
  const tool = createToolPrimitive({
    workflowId: runId,
    backend: durableBackend,
    nextCheckpointId: checkpointIdGenerator,
    throwIfCancelled: () => {
      if (ownController.signal.aborted) {
        throw new Error("atomic-workflows: workflow cancelled");
      }
    },
    signal: ownController.signal,
  });

  // Durable ctx.ui wrapper — caches completed user responses so a resumed workflow does not re-ask answered prompts.
  const durableUiDeps = { workflowId: runId, backend: durableBackend, nextCheckpointId: checkpointIdGenerator };
  const recordCachedStage = (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint): void =>
    recordCachedStageWithTracker(activeStore, tracker, runId, name, replayKey, checkpoint, completedStageReplayKeys);
  const durableTask = createDurableTaskPrimitive({
    workflowId: runId, backend: durableBackend,
    nextReplayKey: (stageName) => stageReplayKeyGenerator(stageName), task: taskRunners.task,
    recordCachedTask: (name, replayKey, checkpoint, scope) =>
      recordCachedStageWithTracker(activeStore, tracker, runId, name, replayKey, checkpoint, completedStageReplayKeys, scope),
  });
  const durableWorkflow = createDurableChildWorkflowPrimitive({
    workflowId: runId, rootWorkflowId: opts.parentRun?.rootRunId ?? runId, backend: durableBackend,
    nextReplayKey: nextDurableChildReplayKey, setChildDurableScope: (scope) => { pendingChildDurableScope = scope; },
    recordCachedStage, workflow,
  });
  const ctx: WorkflowRunContext<TInputs> = {
    inputs: resolvedInputs as TInputs,
    get cwd() { return resolveWorkflowCwd(); },
    exit: exit.exit,
    ui: buildExitGatedUiContext({
      opts,
      throwIfWorkflowExitSelected: exit.throwIfWorkflowExitSelected,
      durableUi: durableUiDeps,
      baseFromPromptNodes: () => buildPromptNodeUiAdapter({
        runId,
        activeStore,
        opts,
        stageControlRegistry: stageRegistry,
        tracker,
        replayIndex,
        signal: ownController.signal,
        throwIfWorkflowExitSelected: exit.throwIfWorkflowExitSelected,
        registerWorkflowExitCleanup: exit.registerWorkflowExitCleanup,
        workflowExitSkippedReason: exit.workflowExitSkippedReason,
        preserveWorkflowExitSkippedReason: exit.preserveWorkflowExitSkippedReason,
        classifyExecutorFailure,
      }),
    }),
    stage: createDurableStagePrimitive({
      workflowId: runId,
      backend: durableBackend,
      nextReplayKey: (stageName) => stageReplayKeyGenerator(stageName),
      recordCachedStage,
      stage: (name, options, replayKey) => {
        const stage = runtime.stage(name, options);
        const stageId = activeStore.runs().find((r) => r.id === runId)?.stages.at(-1)?.id;
        if (stageId !== undefined) completedStageReplayKeys.set(stageId, replayKey);
        return stage;
      },
    }),
    task: durableTask,
    chain: createChainPrimitive({ runtime, task: durableTask }),
    parallel: createParallelPrimitive({ runtime, task: durableTask }),
    workflow: durableWorkflow,
    tool,
  };

  try {
    if (opts.deferWorkflowStart === true) {
      await nextEventLoopTurn();
      if (ownController.signal.aborted) {
        const selectedExit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
        if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);
        const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
        if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
        return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
      }
    }

    if (opts.continuation === undefined && opts.parentRun === undefined) {
      durableBackend.registerWorkflow({ ...durableRootWorkflowRegistration, ...workflowInvocationMetadata(inputRuntimeDefaults, workflowInvocationCwd, gitWorktreeSetupCache) });
    }

    const rawResult = await runWorkflowDefinitionCallback(def.name, runId, () => def.run(ctx));
    if (ownController.signal.aborted) {
      const selectedExit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
      if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);
      const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
      if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const result = normalizeWorkflowRunOutput(def.name, rawResult);
    assertWorkflowRunOutputs(def.name, result, def.outputs);
    assertWorkflowCreatedStage(runSnapshot);
    await durableBackend.flush?.();
    const returned = classifyReturnedRunStatus(result, runSnapshot);
    const recorded = activeStore.recordRunEnd(runId, returned.status, result, returned.error, returned.metadata);
    appendRunEndWhenRecorded(opts.persistence, recorded, { runId, status: returned.status, result, ...(returned.error !== undefined ? { error: returned.error } : {}), ...(returned.metadata ?? {}), ...(runSnapshot.endedAt !== undefined ? { endedAt: runSnapshot.endedAt } : {}), ...(runSnapshot.durationMs !== undefined ? { durationMs: runSnapshot.durationMs } : {}), ts: Date.now() });
    durableBackend.setWorkflowStatus(runId, returned.status, undefined, returned.metadata?.resumable);
    await durableBackend.flush?.();
    if (opts.persistence && durableBackend.persistent) {
      const cacheEntry = durableBackend.toCacheEntry(runId);
      if (cacheEntry) persistDurableCacheEntry(opts.persistence, cacheEntry);
    }
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, { status: returned.status, result, error: returned.error }, opts.onRunEnd);
  } catch (err) {
    const selectedExit = findWorkflowExitSignal(err, exitScope) ?? findWorkflowExitSignal(ownController.signal.reason, exitScope);
    if (selectedExit !== undefined) return await finalizers.finalizeWorkflowExit(selectedExit);

    if (ownController.signal.aborted) {
      const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
      if (parentExit !== undefined) return await finalizers.finalizeParentWorkflowExitCancellation(parentExit);
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const failure = classifyExecutorFailure(err);
    const metadata = selectRunFailureDisposition({
      outerFailure: failure,
      thrownError: err,
      stages: runSnapshot.stages,
      classifyFailure: classifyExecutorFailure,
    });

    if (metadata.failureDisposition === "terminal_killed") {
      for (const failedStageId of metadata.failedStageIds) scheduler.blockKnownNonTerminalDescendants(failedStageId);
      return finalizeKilledByFailure(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd, { ...metadata, resumable: false });
    }

    if (metadata.failureDisposition === "active_blocked" && metadata.failedStageId !== undefined && metadata.failureRecoverability === "recoverable") {
      for (const failedStageId of metadata.failedStageIds) scheduler.blockKnownNonTerminalDescendants(failedStageId);
      return recordActiveBlockedFailure(runId, runSnapshot, activeStore, opts.persistence, {
        ...metadata,
        failureRecoverability: "recoverable",
        failedStageId: metadata.failedStageId,
        resumable: true,
      });
    }

    const recorded = activeStore.recordRunEnd(runId, "failed", undefined, metadata.errorMessage, metadata);
    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "failed",
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
      ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
      ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
      failureMessage: metadata.failureMessage,
      ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
      resumable: metadata.resumable,
      ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
      ...(runSnapshot.endedAt !== undefined ? { endedAt: runSnapshot.endedAt } : {}),
      ...(runSnapshot.durationMs !== undefined ? { durationMs: runSnapshot.durationMs } : {}),
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, { status: "failed", error: metadata.errorMessage }, opts.onRunEnd);
  } finally {
    try {
      await finalizeDurableTerminalStatus({
        runId,
        runSnapshot,
        isRoot: opts.parentRun === undefined,
        durableBackend,
        persistence: opts.persistence,
      });
    } finally {
      gitWorktreeSetupCacheOwner.release(() => opts.cancellation?.unregister(runId));
    }
  }
}
