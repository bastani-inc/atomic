import type { StageControlHandle, AgentSessionEventListener } from "./stage-control-registry.js";
import type { LiveStageRuntime } from "./executor-stage-types.js";
import type { StageUserMessageDeliveryAction } from "./stage-runner-types.js";
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
    async sendUserMessage(text, options) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      runtime.throwIfStageMutationBlocked();
      try {
        const action = await runtime.innerCtx.__sendUserMessage(
          text,
          options,
          runtime.throwIfStageMutationBlocked,
        );
        if (action === "steer" || action === "followUp") {
          runtime.state.resumeContinuationPending = "queued-user-message";
        }
        return action;
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    async prompt(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      let action: StageUserMessageDeliveryAction | undefined;
      try {
        action = await runtime.innerCtx.__sendUserMessage(
          text,
          undefined,
          runtime.throwIfStageMutationBlocked,
        );
      } finally {
        runtime.captureStageSessionMeta();
      }
      if (action !== "handled") runtime.throwIfStageMutationBlocked();
    },
    async steer(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      runtime.throwIfStageMutationBlocked();
      // A user message queued into an in-flight turn should nudge the stage
      // back to its objective once that turn ends: arm the pending flag so
      // drainResumeContinuations injects RESUME_CONTINUATION_PROMPT after the
      // tracked call resolves. Idle deliveries start a fresh user turn and
      // need no continuation nudge, so only arm while streaming.
      const queuedIntoInFlightTurn = runtime.innerCtx.isStreaming;
      try {
        await runtime.innerCtx.steer(text);
        if (queuedIntoInFlightTurn) runtime.state.resumeContinuationPending = "queued-user-message";
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    async followUp(text: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      runtime.throwIfStageMutationBlocked();
      // Same in-flight continuation arming as steer(): see comment above.
      const queuedIntoInFlightTurn = runtime.innerCtx.isStreaming;
      try {
        await runtime.innerCtx.followUp(text);
        if (queuedIntoInFlightTurn) runtime.state.resumeContinuationPending = "queued-user-message";
      } finally {
        runtime.captureStageSessionMeta();
      }
    },
    async pause() {
      runtime.throwIfStageMutationBlocked();
      const statusBeforePause = runtime.stageSnapshot.status;
      if (statusBeforePause === "pending" || statusBeforePause === "running" || runtime.innerCtx.isStreaming) {
        await runtime.innerCtx.__requestPause();
      }
      const changed = runtime.activeStore.recordStagePaused(runtime.runId, runtime.stageId);
      if (changed) {
        runtime.scheduler.ensureReleaseBarrier(runtime.stageId);
        await runtime.scheduler.cascadePauseFrom(runtime.stageId);
        const run = runtime.activeStore.runs().find((candidate) => candidate.id === runtime.runId);
        const stillActive = run?.stages.some(
          (stage) => stage.status === "running" && stage.id !== runtime.stageId,
        ) ?? false;
        if (!stillActive) runtime.activeStore.recordRunPaused(runtime.runId);
      }
      // Graceful pause/quit is an exact durability boundary. Force the latest
      // pause-adjusted stage elapsed time even inside the normal 30s bucket.
      await runtime.captureStageSessionMeta({ forceDurable: true });
    },
    async resume(message?: string) {
      runtime.throwIfStageMutationBlocked();
      await ensureMessagingSession();
      runtime.throwIfStageMutationBlocked();
      const wasPausedBeforeResume = runtime.innerCtx.__isPaused();
      const resumesIdleStageChat = wasPausedBeforeResume && runtime.state.waitingForStageChatTurn;
      const hasMessage = typeof message === "string" && message.trim().length > 0;
      const resumeMessage = hasMessage ? message : undefined;
      const queuedResumeContinuation = wasPausedBeforeResume && !resumesIdleStageChat;
      const previousResumeContinuation = runtime.state.resumeContinuationPending;
      let resumeContinuationChanged = false;
      let wakeReleasedIdleStageChat = false;
      try {
        await runtime.innerCtx.__resume(
          resumesIdleStageChat ? undefined : resumeMessage,
          ({ releasedQueuedMessages, runnerOwnedDeliveryPending }) => {
            if (runnerOwnedDeliveryPending) return;
            if (!releasedQueuedMessages && !queuedResumeContinuation) return;
            resumeContinuationChanged = true;
            runtime.state.resumeContinuationPending = releasedQueuedMessages
              ? "paused-queued-user-message"
              : previousResumeContinuation === false ? "resume" : previousResumeContinuation;
            wakeReleasedIdleStageChat = resumesIdleStageChat && releasedQueuedMessages;
          },
        );
        const changed = runtime.activeStore.recordStageResumed(runtime.runId, runtime.stageId);
        if (changed) {
          runtime.scheduler.releaseStageBarrier(runtime.stageId);
          await runtime.scheduler.cascadeResumeFrom(runtime.stageId);
          // Preserve manual per-stage semantics: once this acknowledged
          // resume succeeds, the run is active even if sibling stages remain paused.
          runtime.activeStore.recordRunResumed(runtime.runId);
        }
        if (wakeReleasedIdleStageChat) runtime.state.wakeWaitingForStageChatTurn?.();
        if (resumesIdleStageChat && hasMessage) {
          runtime.throwIfStageMutationBlocked();
          return await runtime.innerCtx.__sendUserMessage(
            message,
            undefined,
            runtime.throwIfStageMutationBlocked,
          );
        }
      } catch (err) {
        if (resumeContinuationChanged) {
          runtime.state.resumeContinuationPending = previousResumeContinuation;
        }
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
