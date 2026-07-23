import type { StageOptions } from "../../shared/types.js";
import type { ConcurrencyLimiter } from "../shared/concurrency.js";
import type { StageAdapters } from "./stage-runner.js";
import type { LiveStageRuntime } from "./executor-stage-types.js";
import { askReadinessViaStageBroker, RESUME_CONTINUATION_PROMPT, shouldInjectResumeContinuation } from "./executor-hil.js";
import { raceAbort } from "./executor-abort.js";
import { hasExplicitFastModeCandidate } from "./executor-direct-helpers.js";
import { applyFailureToStage } from "./executor-lifecycle.js";
import { isTerminalStage } from "./executor-scheduler.js";
import { rebasedStageStartedAt } from "../../shared/timing.js";

export interface TrackedStageCallOptions {
  readonly eagerSession?: boolean;
  readonly allowFinalized?: boolean;
}

export type TrackedStageCaller = <T>(
  call: () => Promise<T>,
  eagerSessionOrOptions?: boolean | TrackedStageCallOptions,
) => Promise<T>;

function normalizeTrackedStageCallOptions(input: boolean | TrackedStageCallOptions | undefined): Required<TrackedStageCallOptions> {
  if (typeof input === "boolean") return { eagerSession: input, allowFinalized: false };
  return { eagerSession: input?.eagerSession === true, allowFinalized: input?.allowFinalized === true };
}

export function createTrackedStageCaller(input: {
  readonly runtime: LiveStageRuntime;
  readonly limiter: ConcurrencyLimiter;
  readonly options: StageOptions | undefined;
  readonly adapters: StageAdapters;
  readonly hasContinuation: boolean;
  readonly hasScopedParents: boolean;
}): TrackedStageCaller {
  const { runtime } = input;
  const readinessGateEnabled = runtime.opts.confirmStageReadiness !== undefined || runtime.opts.usePromptNodesForUi === true;
  const confirmReadiness = async (): Promise<"advance" | "stay"> => {
    try {
      if (runtime.opts.confirmStageReadiness !== undefined) {
        const ready = await runtime.opts.confirmStageReadiness({
          runId: runtime.runId,
          stageId: runtime.stageId,
          stageName: runtime.name,
          signal: runtime.signal,
        });
        return ready ? "advance" : "stay";
      }
      return await askReadinessViaStageBroker(runtime.runId, runtime.stageId, runtime.signal);
    } catch {
      return "advance";
    }
  };

  const suppressReadinessForCurrentTurn = (): void => {
    runtime.state.askUserQuestionObservedThisTurn = false;
    runtime.state.chatAnswerObservedThisTurn = false;
  };

  const skipResumeContinuationInjection = (): boolean => {
    if (runtime.state.stageFinalized) return true;
    if (runtime.state.skippedForParallelFailFast) return true;
    if (runtime.stageSnapshot.status === "skipped" && runtime.stageSnapshot.skippedReason === "fail-fast") return true;
    if (isTerminalStage(runtime.stageSnapshot)) return true;
    if (runtime.stageFailFastScope?.failed === true && runtime.stageFailFastScope.activeStages.has(runtime.stageId)) return true;
    if (runtime.innerCtx.__structuredOutputFinalized()) return true;
    return false;
  };

  const drainResumeContinuations = async <T>(currentResult: T): Promise<{
    readonly result: T;
    readonly chatAnswerObserved: boolean;
  }> => {
    let result = currentResult;
    let chatAnswerObserved = runtime.state.chatAnswerObservedThisTurn;
    const captureChatAnswer = (): void => {
      chatAnswerObserved ||= runtime.state.chatAnswerObservedThisTurn;
    };
    while (runtime.state.resumeContinuationPending !== false) {
      const reason = runtime.state.resumeContinuationPending;
      runtime.state.resumeContinuationPending = false;
      captureChatAnswer();
      suppressReadinessForCurrentTurn();
      if (!shouldInjectResumeContinuation({
        reason,
        gateEnabled: readinessGateEnabled,
        aborted: runtime.signal.aborted,
      })) {
        continue;
      }
      if (skipResumeContinuationInjection()) continue;
      result = await raceAbort(runtime.innerCtx.prompt(RESUME_CONTINUATION_PROMPT), runtime.signal) as T;
      captureChatAnswer();
    }
    captureChatAnswer();
    return { result, chatAnswerObserved };
  };

  return async <T>(call: () => Promise<T>, eagerSessionOrOptions?: boolean | TrackedStageCallOptions): Promise<T> => {
    const callOptions = normalizeTrackedStageCallOptions(eagerSessionOrOptions);
    runtime.exit.throwIfWorkflowExitSelected();
    await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
    if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();

    await input.limiter.acquire();
    try {
      await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
      runtime.exit.throwIfWorkflowExitSelected();
      if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();
    } catch (err) {
      input.limiter.release();
      throw err;
    }

    const trackStageLifecycle = !runtime.state.stageFinalized;
    if (trackStageLifecycle && !input.hasContinuation && runtime.stageSnapshot.startedAt === undefined && !input.hasScopedParents) {
      const actualParentIds = runtime.scheduler.tracker.currentParents();
      const sameParents = actualParentIds.length === runtime.stageSnapshot.parentIds.length &&
        actualParentIds.every((value) => runtime.stageSnapshot.parentIds.includes(value));
      if (!sameParents) {
        runtime.scheduler.tracker.replaceParents(runtime.stageId, actualParentIds);
        runtime.scheduler.setStageParentIds(runtime.stageSnapshot, actualParentIds);
      }
    }
    if (trackStageLifecycle) {
      const now = Date.now();
      runtime.stageSnapshot.status = "running";
      runtime.stageSnapshot.startedAt ??= rebasedStageStartedAt(input.options?.durableAccumulatedDurationMs, now);
      const hasNoExplicitModelConfig = input.options?.model === undefined && input.options?.fallbackModels === undefined;
      const promptAdapterHandlesInitialPrompt = input.adapters.prompt !== undefined;
      if (callOptions.eagerSession && !promptAdapterHandlesInitialPrompt && (hasNoExplicitModelConfig || await hasExplicitFastModeCandidate({
        model: input.options?.model,
        fallbackModels: input.options?.fallbackModels,
        models: runtime.opts.models,
      }))) {
        try {
          await runtime.innerCtx.__ensureSession();
          runtime.captureStageSessionMeta();
        } catch (err) {
          if (!(err instanceof Error && err.message.includes("prompt adapter not configured"))) throw err;
        }
      }
      runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
      runtime.activeStore.recordStageStart(runtime.runId, runtime.stageSnapshot);
      runtime.appendStageStartOnce();
    } else {
      runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
    }

    runtime.mcpScope.apply();

    try {
      const abortSession = (): void => {
        void runtime.innerCtx.abort().catch(() => {});
      };
      if (runtime.signal.aborted) abortSession();
      else runtime.signal.addEventListener("abort", abortSession, { once: true });
      let result: T;
      try {
        runtime.state.askUserQuestionObservedThisTurn = false;
        runtime.state.chatAnswerObservedThisTurn = false;
        result = await raceAbort(call(), runtime.signal);
        const initialDrain = await drainResumeContinuations(result);
        result = initialDrain.result;
        let repeatReadinessAfterChatTurn = initialDrain.chatAnswerObserved;

        if (
          !runtime.signal.aborted &&
          readinessGateEnabled &&
          (runtime.state.askUserQuestionObservedThisTurn || repeatReadinessAfterChatTurn) &&
          !runtime.innerCtx.__structuredOutputFinalized()
        ) {
          let resolveNextTurnEnd: (() => void) | null = null;
          const unsubscribeTurnWatcher = runtime.innerCtx.subscribe((event) => {
            if ((event as { type?: unknown }).type === "agent_end" && resolveNextTurnEnd) {
              const resolve = resolveNextTurnEnd;
              resolveNextTurnEnd = null;
              resolve();
            }
          });
          try {
            while (runtime.state.askUserQuestionObservedThisTurn || repeatReadinessAfterChatTurn) {
              const decision = await confirmReadiness();
              if (decision === "advance") break;
              if (runtime.signal.aborted) break;
              runtime.state.askUserQuestionObservedThisTurn = false;
              runtime.state.chatAnswerObservedThisTurn = false;
              runtime.state.waitingForStageChatTurn = true;
              try {
                await raceAbort(new Promise<void>((resolve) => { resolveNextTurnEnd = resolve; }), runtime.signal);
              } finally {
                runtime.state.waitingForStageChatTurn = false;
              }
              if (runtime.signal.aborted) break;
              result = (runtime.innerCtx.__getLastAssistantText() ?? result) as T;
              const continuationDrain = await drainResumeContinuations(result);
              result = continuationDrain.result;
              repeatReadinessAfterChatTurn ||= continuationDrain.chatAnswerObserved;
              if (runtime.innerCtx.__structuredOutputFinalized()) break;
            }
          } finally {
            resolveNextTurnEnd = null;
            unsubscribeTurnWatcher();
          }
        }
      } finally {
        runtime.signal.removeEventListener("abort", abortSession);
      }
      await runtime.innerCtx.__closeGeneration();
      runtime.captureStageSessionMeta();
      runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
      if (trackStageLifecycle && runtime.stageFailFastScope?.failed === true && runtime.stageFailFastScope.activeStages.has(runtime.stageId)) {
        runtime.markSkippedForParallelFailFast();
        throw runtime.parallelFailFastError();
      }
      if (trackStageLifecycle && runtime.state.stageFinalized) throw runtime.parallelFailFastError();
      if (trackStageLifecycle) {
        runtime.stageSnapshot.status = "completed";
        const assistantText = runtime.innerCtx.__getLastAssistantText();
        if (assistantText !== undefined) runtime.stageSnapshot.result = assistantText;
      }
      return result;
    } catch (err) {
      const workflowExitAbort = runtime.signal.aborted ? runtime.exit.currentWorkflowExitAbortReason() : undefined;
      if (workflowExitAbort !== undefined && !runtime.state.skippedForParallelFailFast) {
        runtime.state.stageClosedByWorkflowExit = true;
        if (trackStageLifecycle && !isTerminalStage(runtime.stageSnapshot)) {
          runtime.stageSnapshot.status = "skipped";
          runtime.stageSnapshot.skippedReason = runtime.exit.workflowExitSkippedReason(workflowExitAbort.reason);
        }
      } else if (trackStageLifecycle && !runtime.signal.aborted && !runtime.state.skippedForParallelFailFast) {
        applyFailureToStage(runtime.stageSnapshot, runtime.classifyExecutorFailure(err));
      }
      throw err;
    } finally {
      // Finalization, handle release, and limiter release are each independent.
      // If finalizeStageSnapshot() throws, the limiter must still be released
      // so the concurrency semaphore is not leaked.
      // cross-ref: issue #1498 — durable finalization failures must not leak the stage limiter.
      runtime.mcpScope.clear();
      let finalizationError: { readonly thrown: true; readonly error: unknown } | undefined;
      try {
        await runtime.innerCtx.__closeGeneration();
        runtime.captureStageSessionMeta();
      } catch (err) {
        finalizationError = { thrown: true, error: err };
      }
      if (trackStageLifecycle) {
        try {
          await runtime.finalizeStageSnapshot();
        } catch (err) {
          finalizationError ??= { thrown: true, error: err };
        }
        try {
          if (runtime.state.stageClosedByWorkflowExit || runtime.exit.currentWorkflowExitAbortReason() !== undefined) {
            await runtime.releaseLiveHandle().catch(() => {});
          } else {
            await runtime.dropStageControlForCompletion().catch(() => {});
          }
        } catch {
          // Best-effort: handle release failure must not prevent limiter release.
        }
      } else if (runtime.state.stageClosedByWorkflowExit || runtime.exit.currentWorkflowExitAbortReason() !== undefined) {
        await runtime.releaseLiveHandle().catch(() => {});
      }
      input.limiter.release();
      if (finalizationError !== undefined) throw finalizationError.error;
    }
  };
}
