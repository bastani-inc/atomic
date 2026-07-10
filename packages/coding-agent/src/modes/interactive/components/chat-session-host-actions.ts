import type { BashExecutionMessage } from "../../../core/messages.ts";
import { combineQueuedMessagesForEditor } from "../chat-input-actions.ts";
import type { ChatMessageEntry } from "./chat-message-renderer.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import { setChatSessionEditorText } from "./chat-session-host-editor.ts";
import {
  decrementOptimisticUserSignature,
  incrementOptimisticUserSignature,
  isChatSessionBashRunning,
  isChatSessionStreaming,
  notifyChatSessionStatus,
  notifyChatSessionWarning,
  requiredChatSessionCommand,
  syncChatSessionAnimationTick,
} from "./chat-session-host-runtime.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import {
  errorMessage,
  parseBashInput,
  userMessageSignature,
} from "./chat-session-host-utils.ts";

export async function interruptChatSession<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): Promise<void> {
  try {
    restoreQueuedMessagesToEditor(state);
    state.sdkBusy = false;
    state.workingMessage = undefined;
    await state.commands.interrupt?.();
  } catch (err) {
    state.statusMessage = errorMessage(err);
  } finally {
    syncChatSessionAnimationTick(state);
    state.requestRender?.();
  }
}

export async function submitChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  mode: "auto" | "followUp" = "auto",
  submittedText?: string,
): Promise<void> {
  const text = (submittedText ?? state.inputBuffer).trim();
  if (!text) return;
  if (text.startsWith("/") && state.commands.handleSlashCommand) {
    const handled = await state.commands.handleSlashCommand(text);
    if (handled) {
      setChatSessionEditorText(state, "");
      state.requestRender?.();
      return;
    }
  }
  if (state.compacting) {
    setChatSessionEditorText(state, "");
    state.compactionQueuedMessages = [...state.compactionQueuedMessages, text];
    notifyChatSessionStatus(state, "Queued message until compaction completes");
    return;
  }
  const bash = parseBashInput(text);
  if (bash?.command) {
    if (isChatSessionBashRunning(state)) {
      notifyChatSessionWarning(state, "A bash command is already running. esc cancel first.");
      setChatSessionEditorText(state, text);
      return;
    }
    setChatSessionEditorText(state, "");
    await runChatSessionBashCommand(state, bash.command, bash.excludeFromContext);
    return;
  }
  setChatSessionEditorText(state, "");
  const isPaused = state.isPaused?.() === true;
  const isStreaming = isChatSessionStreaming(state);
  const shouldAppendOptimisticUser = mode === "auto" && !isStreaming;
  const optimisticSignature = shouldAppendOptimisticUser
    ? userMessageSignature(text)
    : undefined;
  if (optimisticSignature !== undefined) {
    state.liveChat.appendUserText(text);
    state.bodyViewport.scrollToBottom();
    incrementOptimisticUserSignature(state, optimisticSignature);
  }
  state.requestRender?.();
  try {
    if (isPaused) {
      state.sdkBusy = true;
      state.statusMessage = "resuming…";
      syncChatSessionAnimationTick(state);
      state.requestRender?.();
      await requiredChatSessionCommand(state, "resume")(text);
      state.sdkBusy = false;
      state.statusMessage = "";
      syncChatSessionAnimationTick(state);
      return;
    }
    if (mode === "followUp" && isStreaming) {
      await queueChatSessionFollowUp(state, text);
      return;
    }
    if (isStreaming) {
      await queueChatSessionSteer(state, text);
    } else {
      state.sdkBusy = true;
      syncChatSessionAnimationTick(state);
      await state.commands.ensureAttached?.();
      await requiredChatSessionCommand(state, "prompt")(text);
      state.sdkBusy = false;
      syncChatSessionAnimationTick(state);
    }
  } catch (err) {
    if (optimisticSignature !== undefined) {
      decrementOptimisticUserSignature(state, optimisticSignature);
    }
    state.sdkBusy = false;
    state.statusMessage = errorMessage(err);
    syncChatSessionAnimationTick(state);
    state.requestRender?.();
  }
}

export async function abortChatSessionCompaction<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): Promise<void> {
  try {
    await state.commands.abortCompaction?.();
    state.compacting = false;
    state.sdkBusy = false;
    notifyChatSessionStatus(state, "Compaction cancelled");
  } catch (err) {
    notifyChatSessionWarning(state, errorMessage(err));
  } finally {
    syncChatSessionAnimationTick(state);
    state.requestRender?.();
  }
}

export async function abortChatSessionBash<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
): Promise<void> {
  try {
    await state.commands.abortBash?.();
    state.localBashRunning = false;
    notifyChatSessionStatus(state, "Bash command cancelled");
  } catch (err) {
    notifyChatSessionWarning(state, errorMessage(err));
  } finally {
    state.requestRender?.();
  }
}

export async function flushChatSessionCompactionQueue<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): Promise<void> {
  const queued = [...state.compactionQueuedMessages];
  state.compactionQueuedMessages = [];
  if (queued.length === 0) return;
  let nextIndex = 0;
  try {
    const first = queued[0];
    if (first !== undefined) {
      await requiredChatSessionCommand(state, "prompt")(first);
      nextIndex = 1;
    }
    for (; nextIndex < queued.length; nextIndex++) {
      await queueChatSessionFollowUp(state, queued[nextIndex]!);
    }
  } catch (err) {
    state.compactionQueuedMessages = [
      ...queued.slice(nextIndex),
      ...state.compactionQueuedMessages,
    ];
    notifyChatSessionWarning(state, errorMessage(err));
    state.requestRender?.();
  }
}

export function restoreQueuedMessagesToEditor<
  TExtraEntry extends ChatTranscriptEntryLike,
>(state: ChatSessionHostState<TExtraEntry>): boolean {
  const queuedMessages = [
    ...state.pendingSteeringMessages,
    ...state.pendingFollowUpMessages,
    ...state.compactionQueuedMessages,
  ];
  if (queuedMessages.length === 0) {
    notifyChatSessionStatus(state, "No queued messages to restore");
    return false;
  }
  const restoredText = combineQueuedMessagesForEditor(queuedMessages, state.inputBuffer);
  state.pendingSteeringMessages = [];
  state.pendingFollowUpMessages = [];
  state.compactionQueuedMessages = [];
  setChatSessionEditorText(state, restoredText);
  state.getAgentSession?.()?.clearQueue();
  state.requestRender?.();
  return true;
}

async function runChatSessionBashCommand<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  command: string,
  excludeFromContext: boolean,
): Promise<void> {
  const runBash = state.commands.runBash;
  if (!runBash) {
    notifyChatSessionWarning(state, "no bash command configured for this chat session");
    return;
  }
  const bashMessage: BashExecutionMessage = {
    role: "bashExecution",
    command,
    output: "",
    exitCode: undefined,
    cancelled: false,
    truncated: false,
    timestamp: Date.now(),
    ...(excludeFromContext ? { excludeFromContext: true } : {}),
  };
  const bashEntry: ChatMessageEntry = {
    role: "tool",
    kind: "bashExecution",
    message: bashMessage,
    isPartial: true,
  };
  state.transcript.push(bashEntry);
  state.localBashRunning = true;
  state.bodyViewport.scrollToBottom();
  state.requestRender?.();
  try {
    const result = await runBash({
      command,
      excludeFromContext,
      onChunk: (chunk) => {
        bashMessage.output += chunk;
        state.requestRender?.();
      },
    });
    bashMessage.output = result.output;
    bashMessage.exitCode = result.exitCode;
    bashMessage.cancelled = result.cancelled;
    bashMessage.truncated = result.truncated;
    if (result.fullOutputPath !== undefined) {
      bashMessage.fullOutputPath = result.fullOutputPath;
    }
  } catch (err) {
    bashMessage.output = errorMessage(err);
    bashMessage.exitCode = undefined;
    bashMessage.cancelled = false;
    bashMessage.truncated = false;
  } finally {
    bashEntry.isPartial = false;
    state.localBashRunning = false;
    state.requestRender?.();
  }
}

async function queueChatSessionSteer<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  text: string,
): Promise<void> {
  const agentSession = state.getAgentSession?.();
  if (agentSession?.isStreaming) {
    await agentSession.prompt(text, { streamingBehavior: "steer" });
    return;
  }
  await requiredChatSessionCommand(state, "steer")(text);
}

async function queueChatSessionFollowUp<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  text: string,
): Promise<void> {
  const agentSession = state.getAgentSession?.();
  if (agentSession?.isStreaming) {
    await agentSession.prompt(text, { streamingBehavior: "followUp" });
    return;
  }
  await requiredChatSessionCommand(state, "followUp")(text);
}
