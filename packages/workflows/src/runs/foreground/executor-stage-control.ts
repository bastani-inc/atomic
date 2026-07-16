import type { StageControlHandle, AgentSessionEventListener } from "./stage-control-registry.js";
import type { LiveStageRuntime } from "./executor-stage-types.js";
import { isTerminalStage } from "./executor-scheduler.js";
import { StageToolExecutionBuffer } from "./stage-tool-execution-buffer.js";

export function createStageControlHandle(runtime: LiveStageRuntime): StageControlHandle {
  const ensureMessagingSession = async (): Promise<void> => {
    const meta = runtime.innerCtx.__sessionMeta();
    if (meta.sessionId !== undefined || meta.sessionFile !== undefined) return;
    if (runtime.stageSnapshot.sessionFile !== undefined) {
      await runtime.innerCtx.__ensureSessionFromFile(runtime.stageSnapshot.sessionFile);
      runtime.captureStageSessionMeta();
      return;
    }
    if (isTerminalStage(runtime.stageSnapshot)) {
      throw new Error(`atomic-workflows: cannot message stage "${runtime.name}" because no retained session metadata is available.`);
    }
  };
  const toolExecutions = new StageToolExecutionBuffer();
  const unsubscribeToolExecutions = runtime.innerCtx.subscribe((event) => toolExecutions.record(event));

  return {
    runId: runtime.runId,
    stageId: runtime.stageId,
    stageName: runtime.name,
    get status() {
      return runtime.stageSnapshot.status;
    },
    get sessionId() {
      return runtime.innerCtx.__sessionMeta().sessionId ?? runtime.stageSnapshot.sessionId;
    },
    get sessionFile() {
      return runtime.innerCtx.__sessionMeta().sessionFile ?? runtime.stageSnapshot.sessionFile;
    },
    get isStreaming() {
      return runtime.innerCtx.isStreaming;
    },
    get isDisposed() {
      return runtime.state.liveHandleReleased;
    },
    get messages() {
      return runtime.innerCtx.messages;
    },
    get agentSession() {
      return runtime.innerCtx.__agentSession();
    },
    pendingToolExecutionEvents() {
      return toolExecutions.replayEvents();
    },
    async ensureAttached() {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      await runtime.innerCtx.__ensureSession();
      runtime.throwIfStageMutationBlocked();
      runtime.captureStageSessionMeta();
    },
    async prompt(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      try {
        await runtime.innerCtx.prompt(text);
      } finally {
        runtime.captureStageSessionMeta();
      }
      runtime.throwIfStageMutationBlocked();
    },
    async steer(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      try {
        await runtime.innerCtx.steer(text);
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    async followUp(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      try {
        await runtime.innerCtx.followUp(text);
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    async pause() {
      runtime.throwIfStageMutationBlocked();
      const statusBeforePause = runtime.stageSnapshot.status;
      const changed = runtime.activeStore.recordStagePaused(runtime.runId, runtime.stageId);
      if (changed) {
        runtime.scheduler.ensureReleaseBarrier(runtime.stageId);
        await runtime.scheduler.cascadePauseFrom(runtime.stageId);
        const run = runtime.activeStore.runs().find((candidate) => candidate.id === runtime.runId);
        const stillActive = run?.stages.some(
          (s) => s.status === "running" && s.id !== runtime.stageId,
        ) ?? false;
        if (!stillActive) runtime.activeStore.recordRunPaused(runtime.runId);
      }
      if (statusBeforePause === "pending" || statusBeforePause === "running" || runtime.innerCtx.isStreaming) {
        await runtime.innerCtx.__requestPause();
      }
    },
    async resume(message?: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      const wasPausedBeforeResume = runtime.innerCtx.__isPaused();
      const shouldContinueInterruptedTurn = message === undefined ||
        (typeof message === "string" && message.trim().length > 0);
      const previousResumeContinuationPending = runtime.state.resumeContinuationPending;
      const queuedResumeContinuation = wasPausedBeforeResume && shouldContinueInterruptedTurn;
      if (queuedResumeContinuation) runtime.state.resumeContinuationPending = true;
      try {
        const changed = runtime.activeStore.recordStageResumed(runtime.runId, runtime.stageId);
        if (changed) {
          runtime.scheduler.releaseStageBarrier(runtime.stageId);
          await runtime.scheduler.cascadeResumeFrom(runtime.stageId);
          runtime.activeStore.recordRunResumed(runtime.runId);
        }
        await runtime.innerCtx.__resume(message);
      } catch (err) {
        if (queuedResumeContinuation) runtime.state.resumeContinuationPending = previousResumeContinuationPending;
        throw err;
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    subscribe(listener: AgentSessionEventListener) {
      return runtime.innerCtx.subscribe(listener);
    },
    async dispose() {
      unsubscribeToolExecutions();
      toolExecutions.clear();
      await runtime.releaseLiveHandle();
    },
  };
}
