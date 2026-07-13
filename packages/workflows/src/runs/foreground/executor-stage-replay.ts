import type { StageSnapshot } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import { elapsedStageMs } from "../../shared/timing.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { EngineStageRuntimeOptions } from "../../engine/options.js";
import type { InternalStageContext } from "./stage-runner.js";
import type { WorkflowExitCleanup } from "./executor-types.js";
import { stageReplayFields } from "./executor-lifecycle.js";

export function createReplayStageContext(input: {
  readonly runId: string;
  readonly name: string;
  readonly stageId: string;
  readonly stageSnapshot: StageSnapshot;
  readonly replaySource: StageSnapshot;
  readonly activeStore: Store;
  readonly opts: EngineStageRuntimeOptions;
  readonly tracker: GraphFrontierTracker;
  readonly registerWorkflowExitCleanup: (stageId: string, cleanup: WorkflowExitCleanup) => () => void;
  readonly workflowExitSkippedReason: (reason?: string) => string;
  readonly throwIfWorkflowExitSelected: () => void;
}): InternalStageContext {
  const { runId, name, stageId, stageSnapshot, replaySource } = input;
  let replayFinalization: Promise<void> | undefined;
  let unregisterWorkflowExitCleanup = (): void => {};
  let stageStartEntryAppended = false;

  const appendStageStartOnce = (): void => {
    if (!input.opts.persistence || stageStartEntryAppended) return;
    stageStartEntryAppended = true;
    appendStageStart(input.opts.persistence, {
      runId,
      stageId,
      name,
      parentIds: stageSnapshot.parentIds,
      ...stageReplayFields(stageSnapshot),
      ts: stageSnapshot.startedAt ?? Date.now(),
    });
  };

  const appendReplayStageEnd = (): void => {
    if (!input.opts.persistence) return;
    appendStageEnd(input.opts.persistence, {
      runId,
      stageId,
      status: stageSnapshot.status,
      durationMs: stageSnapshot.durationMs ?? 0,
      ...(stageSnapshot.status === "completed" && stageSnapshot.result !== undefined ? { summary: stageSnapshot.result } : {}),
      ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
      ...(stageSnapshot.sessionId !== undefined ? { sessionId: stageSnapshot.sessionId } : {}),
      ...(stageSnapshot.sessionFile !== undefined ? { sessionFile: stageSnapshot.sessionFile } : {}),
      ...(stageSnapshot.usage !== undefined ? { usage: stageSnapshot.usage } : {}),
      ...(stageSnapshot.usageComplete !== undefined ? { usageComplete: stageSnapshot.usageComplete } : {}),
      ...stageReplayFields(stageSnapshot),
    });
  };

  const finalizeReplayStage = (status: "completed" | "skipped", reason?: string): Promise<void> => {
    if (replayFinalization) return replayFinalization;
    replayFinalization = (async () => {
      unregisterWorkflowExitCleanup();
      stageSnapshot.status = status;
      if (status === "skipped") {
        delete stageSnapshot.result;
        stageSnapshot.skippedReason = input.workflowExitSkippedReason(reason);
      }
      stageSnapshot.endedAt = Date.now();
      stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
      input.activeStore.recordStageEnd(runId, stageSnapshot);
      appendReplayStageEnd();
      if (stageSnapshot.usage && stageSnapshot.sessionId) {
        input.opts.usageRollup?.emitStageRollup(stageId, stageSnapshot.usage, {
          label: name,
          sessionId: stageSnapshot.sessionId,
          sessionFile: stageSnapshot.sessionFile,
          settled: stageSnapshot.usageComplete !== false,
        });
      }
      await input.opts.onStageEnd?.(runId, stageSnapshot);
      input.tracker.onSettle(stageId);
    })();
    return replayFinalization;
  };

  input.activeStore.recordStageStart(runId, stageSnapshot);
  input.opts.onStageStart?.(runId, stageSnapshot);
  appendStageStartOnce();
  unregisterWorkflowExitCleanup = input.registerWorkflowExitCleanup(stageId, {
    async skipForWorkflowExit(reason?: string): Promise<void> {
      await finalizeReplayStage("skipped", reason);
    },
  });

  const replayResult = replaySource.result ?? "";
  const replayText = async (): Promise<string> => {
    await Promise.resolve();
    input.throwIfWorkflowExitSelected();
    await finalizeReplayStage("completed");
    return replayResult;
  };
  const rejectReplayMutation = (action: string): never => {
    throw new Error(`atomic-workflows: replayed stage "${name}" cannot ${action}`);
  };

  return {
    name,
    prompt: replayText,
    complete: replayText,
    sendUserMessage: async () => rejectReplayMutation("send a user message"),
    steer: async () => rejectReplayMutation("steer"),
    followUp: async () => rejectReplayMutation("follow up"),
    subscribe: () => () => {},
    get sessionFile() { return replaySource.sessionFile; },
    get sessionId() { return replaySource.sessionId ?? ""; },
    setModel: async () => rejectReplayMutation("set model"),
    setThinkingLevel: () => rejectReplayMutation("set thinking level"),
    cycleModel: async () => rejectReplayMutation("cycle model"),
    cycleThinkingLevel: () => rejectReplayMutation("cycle thinking level"),
    get agent() { return undefined as never; },
    get model() { return replaySource.model as never; },
    get thinkingLevel() { return undefined as never; },
    get messages() { return [] as never; },
    get isStreaming() { return false; },
    navigateTree: async () => rejectReplayMutation("navigate conversation tree"),
    compact: async () => rejectReplayMutation("compact"),
    abortCompaction: () => rejectReplayMutation("abort compaction"),
    abort: async () => rejectReplayMutation("abort"),
    __dispose: async () => {},
    __getLastAssistantText: () => replayResult,
    getLastAssistantText: () => replayResult,
    __ensureSession: async () => {},
    __ensureSessionFromFile: async () => {},
    __sessionMeta: () => ({ sessionId: replaySource.sessionId, sessionFile: replaySource.sessionFile }),
    __agentSession: () => undefined,
    __pendingMessageCount: () => 0,
    __modelFallbackMeta: () => ({
      ...(replaySource.model !== undefined ? { model: replaySource.model } : {}),
      ...(replaySource.fastMode === true ? { fastMode: replaySource.fastMode } : {}),
      ...(replaySource.attemptedModels !== undefined ? { attemptedModels: replaySource.attemptedModels } : {}),
      ...(replaySource.modelAttempts !== undefined ? { modelAttempts: replaySource.modelAttempts } : {}),
    }),
    __requestPause: async () => rejectReplayMutation("pause"),
    __resume: async () => rejectReplayMutation("resume"),
    __isPaused: () => false,
    __structuredOutputFinalized: () => false,
  };
}
