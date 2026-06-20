import type { RunSnapshot } from "../../shared/store-types.js";
import type {
  WorkflowDefinition,
  WorkflowInputValues,
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowRunContext,
  WorkflowUIContext,
} from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import { classifyWorkflowFailure } from "../../shared/workflow-failures.js";
import { store as defaultStore } from "../../shared/store.js";
import { appendRunStart } from "../../shared/persistence-session-entries.js";
import { GraphFrontierTracker } from "../shared/graph-inference.js";
import { createRunLimiter } from "../shared/concurrency.js";
import { stageControlRegistry as defaultStageControlRegistry } from "./stage-control-registry.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import { unknownErrorMessage, findWorkflowExitSignal, parentWorkflowExitAbortReason } from "./executor-abort.js";
import { createWorkflowExitManager } from "./executor-exit-manager.js";
import { resolveAndValidateInputs, resolveInputConcurrency, resolveInputRuntimeDefaults } from "./executor-inputs.js";
import { workflowCwdWithInputWorktree } from "./executor-direct-helpers.js";
import { createStageScheduler } from "./executor-scheduler.js";
import { createRunFinalizers } from "./executor-run-finalizers.js";
import { createWorkflowBoundaryFactory } from "./executor-child-boundary.js";
import { createWorkflowStageFactory } from "./executor-stage-factory.js";
import { createWorkflowTaskRunners } from "./executor-task-context.js";
import { createChildWorkflowRunner } from "./executor-child-workflow.js";
import { createContinuationReplayIndex } from "./executor-continuation.js";
import { buildPromptNodeUiAdapter } from "./executor-prompt-nodes.js";
import { makeHeadlessUnavailableUIContext, normalizeUIContext } from "./executor-hil.js";
import {
  appendRunEndWhenRecorded,
  assertWorkflowCreatedStage,
  finalizeKilled,
  finalizeKilledByFailure,
  recordActiveBlockedFailure,
  reconcileTerminalRunResult,
  selectRunFailureDisposition,
} from "./executor-lifecycle.js";
import { assertWorkflowRunOutputs, normalizeWorkflowRunOutput } from "./executor-outputs.js";
import { isWorkflowDefinition, workflowDefinitionRequirementMessage } from "./executor-child-helpers.js";

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildExitGatedUiContext(input: {
  readonly opts: RunOpts;
  readonly baseFromPromptNodes: () => WorkflowUIContext;
  readonly throwIfWorkflowExitSelected: () => void;
}): WorkflowUIContext {
  const base = input.opts.usePromptNodesForUi === true
    ? input.baseFromPromptNodes()
    : input.opts.executionMode === "non_interactive" && input.opts.ui === undefined
      ? makeHeadlessUnavailableUIContext()
      : normalizeUIContext(input.opts.ui);
  return {
    async input(promptText: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await base.input(promptText);
    },
    async confirm(message: string): Promise<boolean> {
      input.throwIfWorkflowExitSelected();
      return await base.confirm(message);
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await base.select(message, options);
    },
    async editor(initial?: string): Promise<string> {
      input.throwIfWorkflowExitSelected();
      return await base.editor(initial);
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      input.throwIfWorkflowExitSelected();
      return await base.custom(factory, options);
    },
  };
}

export async function run<TInputs extends WorkflowInputValues>(
  def: WorkflowDefinition<TInputs>,
  inputs: Readonly<Record<string, unknown>>,
  opts: RunOpts = {},
): Promise<RunResult> {
  if (!isWorkflowDefinition(def)) throw new Error(workflowDefinitionRequirementMessage("run(definition, inputs)", def));

  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};
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
  const inputRuntimeDefaults = resolveInputRuntimeDefaults(def, resolvedInputs);
  const workflowInvocationCwd = opts.cwd ?? process.cwd();
  let workflowCwd: string | undefined;
  const resolveWorkflowCwd = (): string => {
    workflowCwd ??= workflowCwdWithInputWorktree(inputRuntimeDefaults, workflowInvocationCwd);
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
  const startWorkflowBoundaryStage = createWorkflowBoundaryFactory({
    runId,
    runSnapshot,
    activeStore,
    opts,
    tracker,
    replayIndex,
    registerWorkflowExitCleanup: exit.registerWorkflowExitCleanup,
    workflowExitSkippedReason: exit.workflowExitSkippedReason,
    classifyExecutorFailure,
  });
  const workflowBoundaryReplayCounts = new Map<string, number>();
  const nextWorkflowBoundaryReplayKey = (name: string): string => {
    const next = (workflowBoundaryReplayCounts.get(name) ?? 0) + 1;
    workflowBoundaryReplayCounts.set(name, next);
    return `workflow:${name}:${next}`;
  };
  const stage = createWorkflowStageFactory({
    runId,
    activeStore,
    opts,
    adapters,
    signal: ownController.signal,
    tracker,
    scheduler,
    replayIndex,
    limiter,
    inputRuntimeDefaults,
    workflowInvocationCwd,
    stageRegistry,
    exit,
    classifyExecutorFailure,
  });
  const taskRunners = createWorkflowTaskRunners({
    runId,
    exit,
    tracker,
    inputRuntimeDefaults,
    workflowInvocationCwd,
    stage,
  });
  const workflow = createChildWorkflowRunner({
    runId,
    depth,
    opts,
    exit,
    ownController,
    resolveWorkflowCwd,
    nextWorkflowBoundaryReplayKey,
    startWorkflowBoundaryStage,
    runWorkflow: run,
  });

  const ctx: WorkflowRunContext<TInputs> = {
    inputs: resolvedInputs as TInputs,
    get cwd() { return resolveWorkflowCwd(); },
    exit: exit.exit,
    ui: buildExitGatedUiContext({
      opts,
      throwIfWorkflowExitSelected: exit.throwIfWorkflowExitSelected,
      baseFromPromptNodes: () => buildPromptNodeUiAdapter({
        runId,
        activeStore,
        opts,
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
    stage,
    task: taskRunners.task,
    chain: taskRunners.chain,
    parallel: taskRunners.parallel,
    workflow,
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

    const rawResult = await def.run(ctx);
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
    const recorded = activeStore.recordRunEnd(runId, "completed", result);
    appendRunEndWhenRecorded(opts.persistence, recorded, { runId, status: "completed", result, ts: Date.now() });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, { status: "completed", result }, opts.onRunEnd);
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
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, { status: "failed", error: metadata.errorMessage }, opts.onRunEnd);
  } finally {
    opts.cancellation?.unregister(runId);
  }
}
