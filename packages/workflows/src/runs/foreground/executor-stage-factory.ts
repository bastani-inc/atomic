import type { Store } from "../../shared/store.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { StageOptions } from "../../shared/types.js";
import { stageUiBroker } from "../../shared/stage-ui-broker.js";
import { buildStagePromptAdapter } from "../../shared/stage-prompt.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import { elapsedStageMs } from "../../shared/timing.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { ConcurrencyLimiter } from "../shared/concurrency.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { EngineStageRuntimeOptions } from "../../engine/options.js";
import { createStageContext as createInnerStageContext, type InternalStageContext, type StageAdapters } from "./stage-runner.js";
import type { StageControlRegistry } from "./stage-control-registry.js";
import type { ParallelFailFastScope } from "./executor-types.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import type { ContinuationReplayIndex } from "./executor-continuation.js";
import { sameStringSet } from "./executor-continuation.js";
import type { StageScheduler } from "./executor-scheduler.js";
import { isTerminalStage } from "./executor-scheduler.js";
import { stageReplayFields } from "./executor-lifecycle.js";
import { askUserQuestionToolEvent, toolResultHasChatAnswer } from "./executor-hil.js";
import { createReplayStageContext } from "./executor-stage-replay.js";
import type { LiveStageMutableState, LiveStageRuntime, StageContextWithMeta, StageMcpScope } from "./executor-stage-types.js";
import { createStageControlHandle } from "./executor-stage-control.js";
import { createTrackedStageCaller } from "./executor-stage-call.js";
import { createStageContext } from "./executor-stage-context.js";
import { stageOptionsWithGitWorktree, stageOptionsWithInputDefaults } from "./executor-direct-helpers.js";

export function createWorkflowStageFactory(input: {
  readonly runId: string;
  readonly activeStore: Store;
  readonly opts: EngineStageRuntimeOptions;
  readonly adapters: StageAdapters;
  readonly signal: AbortSignal;
  readonly tracker: GraphFrontierTracker;
  readonly scheduler: StageScheduler;
  readonly replayIndex: ContinuationReplayIndex;
  readonly limiter: ConcurrencyLimiter;
  readonly inputRuntimeDefaults: Partial<StageOptions>;
  readonly workflowInvocationCwd: string;
  readonly stageRegistry: StageControlRegistry;
  readonly exit: WorkflowExitManager;
  readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
  readonly createMcpScope: (stageId: string, options: StageOptions | undefined) => StageMcpScope;
}): (name: string, options?: StageOptions, stageFailFastScope?: ParallelFailFastScope) => StageContextWithMeta {
  return (name: string, options?: StageOptions, stageFailFastScope?: ParallelFailFastScope): StageContextWithMeta => {
    input.exit.throwIfWorkflowExitSelected();
    options = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(options, input.inputRuntimeDefaults), input.workflowInvocationCwd);
    const stageId = crypto.randomUUID();
    const provisionalParentIds = input.tracker.onSpawn(stageId, name);
    const scopedParentIds = input.opts.continuation === undefined ? stageFailFastScope?.parentIds : undefined;
    const initialParentIds = scopedParentIds === undefined ? provisionalParentIds : [...scopedParentIds];
    if (scopedParentIds !== undefined && !sameStringSet(scopedParentIds, provisionalParentIds)) {
      input.tracker.replaceParents(stageId, scopedParentIds);
    }

    const replayKey = `stage:${name}`;
    const replayDecision = input.replayIndex.decide({
      displayName: name,
      replayKey,
      parentIds: initialParentIds,
      stageId,
      kind: "stage",
    });
    const parentIds = replayDecision.parentIds;
    if (!sameStringSet(parentIds, provisionalParentIds)) input.tracker.replaceParents(stageId, parentIds);
    const replaySource = replayDecision.kind === "replay" ? replayDecision.source : undefined;
    const executeReplaySource = replayDecision.kind === "execute" ? replayDecision.source : undefined;
    const shouldReplay = replaySource !== undefined;

    const stageSnapshot: StageSnapshot = {
      id: stageId,
      name,
      replayKey,
      status: shouldReplay ? "completed" : "pending",
      parentIds: Object.freeze(parentIds),
      toolEvents: [],
      ...(shouldReplay ? {
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationMs: 0,
        ...(replaySource.result !== undefined ? { result: replaySource.result } : {}),
        ...(replaySource.sessionId !== undefined ? { sessionId: replaySource.sessionId } : {}),
        ...(replaySource.sessionFile !== undefined ? { sessionFile: replaySource.sessionFile } : {}),
        replayedFromStageId: replaySource.id,
        replayed: true,
      } : {}),
      ...(options?.mcp !== undefined ? { mcpScope: { allow: options.mcp.allow ?? null, deny: options.mcp.deny ?? null } } : {}),
      attachable: !shouldReplay,
    };

    if (shouldReplay) {
      return createReplayStageContext({
        runId: input.runId,
        name,
        stageId,
        stageSnapshot,
        replaySource,
        activeStore: input.activeStore,
        opts: input.opts,
        tracker: input.tracker,
        registerWorkflowExitCleanup: input.exit.registerWorkflowExitCleanup,
        workflowExitSkippedReason: input.exit.workflowExitSkippedReason,
        throwIfWorkflowExitSelected: input.exit.throwIfWorkflowExitSelected,
      }) as StageContextWithMeta;
    }

    const stageOptionsForContext: StageOptions | undefined = executeReplaySource?.sessionFile === undefined
      ? options
      : {
          ...(options ?? {}),
          context: options?.context ?? "fork",
          forkFromSessionFile: options?.forkFromSessionFile ?? executeReplaySource.sessionFile,
        };

    const applyModelFallbackMeta = (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>): void => {
      if (meta.model !== undefined) stageSnapshot.model = meta.model;
      if (meta.fastMode !== undefined) {
        if (meta.fastMode) stageSnapshot.fastMode = true;
        else delete stageSnapshot.fastMode;
      }
      if (meta.attemptedModels !== undefined) stageSnapshot.attemptedModels = meta.attemptedModels;
      if (meta.modelAttempts !== undefined) stageSnapshot.modelAttempts = meta.modelAttempts;
    };

    const innerCtx = createInnerStageContext({
      stageId,
      stageName: name,
      adapters: input.adapters,
      runId: input.runId,
      signal: input.signal,
      stageOptions: stageOptionsForContext,
      models: input.opts.models,
      executionMode: input.opts.executionMode,
      defaultSessionDir: input.opts.defaultSessionDir,
      onModelFallbackMetaChange(meta) {
        applyModelFallbackMeta(meta);
        if (stageSnapshot.status === "running") input.activeStore.recordStageStart(input.runId, stageSnapshot);
      },
    });

    const state: LiveStageMutableState = {
      activeAskUserQuestionAnonymousCalls: 0,
      askUserQuestionObservedThisTurn: false,
      chatAnswerObservedThisTurn: false,
      resumeContinuationPending: false,
      liveHandleReleased: false,
      stageClosedByWorkflowExit: false,
      stageFinalized: false,
      skippedForParallelFailFast: false,
      stageControlDropped: false,
    };
    const activeAskUserQuestionCalls = new Set<string>();
    const hasActiveAskUserQuestion = (): boolean => activeAskUserQuestionCalls.size > 0 || state.activeAskUserQuestionAnonymousCalls > 0;
    const unsubscribeAskUserQuestionWatcher = innerCtx.subscribe((event) => {
      const toolEvent = askUserQuestionToolEvent(event);
      if (!toolEvent) return;
      if (toolEvent.phase === "start") {
        state.askUserQuestionObservedThisTurn = true;
        if (toolEvent.callId !== undefined) activeAskUserQuestionCalls.add(toolEvent.callId);
        else state.activeAskUserQuestionAnonymousCalls += 1;
        const adapter = buildStagePromptAdapter(toolEvent.callId ?? `ask-user-question-${stageId}`, "ask_user_question", toolEvent.args, Date.now());
        if (adapter) stageUiBroker.provideStagePrompt(input.runId, stageId, adapter);
        input.activeStore.recordStageAwaitingInput(input.runId, stageId, true);
        return;
      }
      if (toolEvent.callId !== undefined && activeAskUserQuestionCalls.has(toolEvent.callId)) {
        activeAskUserQuestionCalls.delete(toolEvent.callId);
      } else if (toolEvent.callId === undefined && toolEvent.nameMatched) {
        state.activeAskUserQuestionAnonymousCalls = Math.max(0, state.activeAskUserQuestionAnonymousCalls - 1);
      } else {
        return;
      }
      if (toolResultHasChatAnswer((event as Record<string, unknown>)["result"])) state.chatAnswerObservedThisTurn = true;
      if (!hasActiveAskUserQuestion()) {
        input.activeStore.recordStageAwaitingInput(input.runId, stageId, false);
        stageUiBroker.clearStagePrompt(input.runId, stageId);
      }
    });

    const disposeInnerContext = async (): Promise<void> => {
      unsubscribeAskUserQuestionWatcher();
      activeAskUserQuestionCalls.clear();
      state.activeAskUserQuestionAnonymousCalls = 0;
      input.activeStore.recordStageAwaitingInput(input.runId, stageId, false);
      stageUiBroker.clearStagePrompt(input.runId, stageId);
      await innerCtx.__dispose();
    };

    let runtime: LiveStageRuntime;
    const captureStageSessionMeta = (): void => {
      const meta = innerCtx.__sessionMeta();
      if (meta.sessionId !== undefined) stageSnapshot.sessionId = meta.sessionId;
      if (meta.sessionFile !== undefined) stageSnapshot.sessionFile = meta.sessionFile;
      if (meta.sessionId !== undefined || meta.sessionFile !== undefined) input.activeStore.recordStageSession(input.runId, stageId, meta);
    };
    const releaseLiveHandle = async (): Promise<void> => {
      if (state.liveHandleReleased) return;
      state.liveHandleReleased = true;
      runtime.dropStageControlHandle();
      runtime.unregisterStageHandle();
      await disposeInnerContext();
    };
    const dropStageControlForCompletion = async (): Promise<void> => {
      runtime.dropStageControlHandle();
    };
    const throwIfStageMutationBlocked = (): void => {
      if (state.stageClosedByWorkflowExit) {
        input.exit.throwIfWorkflowExitSelected();
        throw new Error(`atomic-workflows: stage "${name}" skipped by workflow exit`);
      }
      input.exit.throwIfWorkflowExitSelected();
    };

    let stageStartEntryAppended = false;
    const appendStageStartOnce = (): void => {
      if (!input.opts.persistence || stageStartEntryAppended) return;
      stageStartEntryAppended = true;
      appendStageStart(input.opts.persistence, {
        runId: input.runId,
        stageId,
        name,
        parentIds: stageSnapshot.parentIds,
        ...stageReplayFields(stageSnapshot),
        ts: stageSnapshot.startedAt ?? Date.now(),
      });
    };

    const finalizeStageSnapshot = async (): Promise<boolean> => {
      if (state.stageFinalized) return false;
      if (stageSnapshot.endedAt !== undefined && isTerminalStage(stageSnapshot)) {
        state.stageFinalized = true;
        runtime.unregisterWorkflowExitCleanup();
        stageFailFastScope?.activeStages.delete(stageId);
        input.tracker.onSettle(stageId);
        return false;
      }
      state.stageFinalized = true;
      runtime.unregisterWorkflowExitCleanup();
      stageSnapshot.endedAt = Date.now();
      stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
      applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
      input.activeStore.recordStageEnd(input.runId, stageSnapshot);
      stageUiBroker.cancelStagePrompt(input.runId, stageId, new Error(`atomic-workflows: stage ${stageId} completed with pending custom UI`));
      await input.opts.onStageEnd?.(input.runId, stageSnapshot);
      if (input.opts.persistence) {
        appendStageStartOnce();
        appendStageEnd(input.opts.persistence, {
          runId: input.runId,
          stageId,
          status: stageSnapshot.status,
          durationMs: stageSnapshot.durationMs,
          ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
          ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
          ...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
          ...(stageSnapshot.failureRecoverability !== undefined ? { failureRecoverability: stageSnapshot.failureRecoverability } : {}),
          ...(stageSnapshot.failureDisposition !== undefined ? { failureDisposition: stageSnapshot.failureDisposition } : {}),
          ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
          ...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
          ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
          ...(stageSnapshot.sessionId !== undefined ? { sessionId: stageSnapshot.sessionId } : {}),
          ...(stageSnapshot.sessionFile !== undefined ? { sessionFile: stageSnapshot.sessionFile } : {}),
          ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
          ...stageReplayFields(stageSnapshot),
        });
      }
      stageFailFastScope?.activeStages.delete(stageId);
      input.tracker.onSettle(stageId);
      return true;
    };

    const markSkippedForParallelFailFast = (): void => {
      state.skippedForParallelFailFast = true;
      stageSnapshot.status = "skipped";
      stageSnapshot.skippedReason = "fail-fast";
    };
    const parallelFailFastError = (): unknown => stageFailFastScope?.firstFailure ?? new Error("atomic-workflows: skipped after parallel fail-fast");

    runtime = {
      runId: input.runId,
      stageId,
      name,
      stageSnapshot,
      innerCtx,
      activeStore: input.activeStore,
      opts: input.opts,
      stageRegistry: input.stageRegistry,
      scheduler: input.scheduler,
      signal: input.signal,
      exit: input.exit,
      classifyExecutorFailure: input.classifyExecutorFailure,
      mcpScope: input.createMcpScope(stageId, options),
      ...(stageFailFastScope !== undefined ? { stageFailFastScope } : {}),
      state,
      unregisterStageHandle: () => {},
      dropStageControlHandle: () => {},
      unregisterWorkflowExitCleanup: () => {},
      captureStageSessionMeta,
      applyModelFallbackMeta,
      appendStageStartOnce,
      finalizeStageSnapshot,
      releaseLiveHandle,
      dropStageControlForCompletion,
      markSkippedForParallelFailFast,
      parallelFailFastError,
      throwIfStageMutationBlocked,
    };

    const handle = createStageControlHandle(runtime);
    runtime.dropStageControlHandle = (): void => {
      if (state.stageControlDropped) return;
      state.stageControlDropped = true;
      input.activeStore.recordStageAttachable(input.runId, stageId, false);
      input.stageRegistry.detachControl(input.runId, stageId, handle);
    };
    runtime.unregisterStageHandle = input.stageRegistry.register(handle);

    input.activeStore.recordStageStart(input.runId, stageSnapshot);
    input.opts.onStageStart?.(input.runId, stageSnapshot);
    const blockedBy = input.scheduler.blockingAncestorFor(stageSnapshot);
    if (blockedBy !== undefined) input.scheduler.blockStageUntilCascadeRelease(stageSnapshot, blockedBy);

    // Parallel fail-fast and workflow-exit cleanup can both target a live stage.
    // The first terminal path owns the snapshot: finalization unregisters
    // workflow-exit cleanup and removes the stage from the fail-fast active set.
    // Later paths must not overwrite the terminal skippedReason; they only abort
    // and release idempotent live handles.
    const skipForParallelFailFast = (): void => {
      if (isTerminalStage(stageSnapshot)) return;
      markSkippedForParallelFailFast();
      void finalizeStageSnapshot();
      void innerCtx.abort().catch(() => {});
      void dropStageControlForCompletion().catch(() => {});
    };
    stageFailFastScope?.activeStages.set(stageId, { skip: skipForParallelFailFast });
    runtime.unregisterWorkflowExitCleanup = input.exit.registerWorkflowExitCleanup(stageId, {
      async skipForWorkflowExit(reason?: string): Promise<void> {
        state.stageClosedByWorkflowExit = true;
        if (!isTerminalStage(stageSnapshot)) {
          stageSnapshot.status = "skipped";
          stageSnapshot.skippedReason = input.exit.workflowExitSkippedReason(reason);
          await finalizeStageSnapshot();
        }
        await innerCtx.abort().catch(() => {});
        await releaseLiveHandle().catch(() => {});
      },
    });

    const runTrackedStageCall = createTrackedStageCaller({
      runtime,
      limiter: input.limiter,
      options,
      adapters: input.adapters,
      hasContinuation: input.opts.continuation !== undefined,
      hasScopedParents: stageFailFastScope?.parentIds !== undefined,
    });
    return createStageContext({ runtime, runTrackedStageCall });
  };
}
