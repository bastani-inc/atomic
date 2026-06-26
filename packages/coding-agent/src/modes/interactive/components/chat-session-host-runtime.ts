import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import { finalizeTerminalWorkflowToolEntries } from "./chat-session-host-terminal-cleanup.ts";
import {
  ANIMATION_FRAME_MS,
  STREAMING_RENDER_THROTTLE_MS,
} from "./chat-session-host-utils.ts";

export function isChatSessionStreaming<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): boolean {
  return state.sdkBusy || state.isStreamingOverride?.() === true;
}

export function isChatSessionBashRunning<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): boolean {
  return state.localBashRunning || state.isBashRunningOverride?.() === true;
}

export function incrementOptimisticUserSignature<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  signature: string,
): void {
  state.optimisticUserSignatureCounts.set(
    signature,
    (state.optimisticUserSignatureCounts.get(signature) ?? 0) + 1,
  );
}

export function decrementOptimisticUserSignature<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  signature: string,
): void {
  const count = state.optimisticUserSignatureCounts.get(signature) ?? 0;
  if (count <= 1) state.optimisticUserSignatureCounts.delete(signature);
  else state.optimisticUserSignatureCounts.set(signature, count - 1);
}

export function syncChatSessionAnimationTick<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): void {
  const shouldAnimate =
    isChatSessionStreaming(state) ||
    (state.sdkBusy && state.liveChat.pendingToolIds().length > 0);
  if (shouldAnimate && !state.animationTimer) {
    state.animationTimer = setInterval(() => {
      state.requestRender?.();
    }, ANIMATION_FRAME_MS);
    state.animationTimer.unref?.();
    return;
  }
  if (!shouldAnimate && state.animationTimer) {
    clearInterval(state.animationTimer);
    state.animationTimer = undefined;
  }
}

export function clearChatSessionBusyForTerminalWorkflowStage<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): void {
  state.sdkBusy = false;
  state.workingMessage = undefined;
  if (finalizeTerminalWorkflowToolEntries(state.transcript)) {
    state.transcriptComponent.invalidate();
  }
  state.liveChat.clearPendingTools();
  state.statusMessage = "";
  syncChatSessionAnimationTick(state);
}

export function disposeChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): void {
  if (state.animationTimer) {
    clearInterval(state.animationTimer);
    state.animationTimer = undefined;
  }
  if (state.renderThrottleTimer) {
    clearTimeout(state.renderThrottleTimer);
    state.renderThrottleTimer = undefined;
  }
  state.transcriptComponent.invalidate();
  state.editor = undefined;
}

export function notifyChatSessionWarning<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  message: string,
): void {
  state.statusMessage = message;
  state.showWarning?.(message);
  state.requestRender?.();
}

export function notifyChatSessionStatus<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  message: string,
): void {
  state.statusMessage = message;
  state.showStatus?.(message);
  state.requestRender?.();
}

export function requiredChatSessionCommand<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  name: "prompt" | "steer" | "followUp" | "resume",
): (text?: string) => Promise<void> {
  switch (name) {
    case "prompt":
      return async (text) => {
        if (!state.commands.prompt) throw new Error("no prompt command configured for this chat session");
        await state.commands.prompt(text ?? "");
      };
    case "steer":
      return async (text) => {
        if (!state.commands.steer) throw new Error("no steer command configured for this chat session");
        await state.commands.steer(text ?? "");
      };
    case "followUp":
      return async (text) => {
        if (!state.commands.followUp) throw new Error("no followUp command configured for this chat session");
        await state.commands.followUp(text ?? "");
      };
    case "resume":
      return async (text) => {
        if (!state.commands.resume) throw new Error("no resume command configured for this chat session");
        await state.commands.resume(text);
      };
  }
}

export function afterChatSessionEvent<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  changed: boolean,
): void {
  syncChatSessionAnimationTick(state);
  if (!changed) return;
  requestChatSessionEventRender(state);
}

function requestChatSessionEventRender<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): void {
  if (!isChatSessionStreaming(state)) {
    state.requestRender?.();
    return;
  }
  if (state.renderThrottleTimer) return;
  state.renderThrottleTimer = setTimeout(() => {
    state.renderThrottleTimer = undefined;
    state.requestRender?.();
  }, STREAMING_RENDER_THROTTLE_MS);
  state.renderThrottleTimer.unref?.();
}
