import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import {
  VERBATIM_COMPACTION_FORMAT_FULL,
  VERBATIM_COMPACTION_STRATEGY,
  type VerbatimCompactionDetails,
  type VerbatimCompactionResult,
} from "../../../core/compaction/index.ts";
import {
  createVerbatimCompactionMessage,
  isVerbatimCompactionMessage,
  type CustomMessage,
} from "../../../core/messages.ts";
import { pickWhimsicalWorkingMessage } from "../whimsical-messages.ts";
import { flushChatSessionCompactionQueue } from "./chat-session-host-actions.ts";
import {
  afterChatSessionEvent,
  decrementOptimisticUserSignature,
} from "./chat-session-host-runtime.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import {
  extractMessageText,
  isMessageLike,
  isUserMessageLike,
  userMessageSignature,
} from "./chat-session-host-utils.ts";

type CompactionReason = "manual" | "threshold" | "overflow";

function compactionStatusMessage(reason: CompactionReason): string {
  switch (reason) {
    case "manual":
      return "Compacting context...";
    case "threshold":
      return "Auto-compacting...";
    case "overflow":
      return "Context overflow detected. Auto-compacting...";
  }
}

function hasVerbatimCompactionMessage(messages: AgentSession["messages"]): boolean {
  return messages.some(
    (message) => message.role === "custom" && isVerbatimCompactionMessage(message),
  );
}

function isCompleteCompactionResult(result: VerbatimCompactionResult): boolean {
  return (
    typeof result.compactedText === "string" &&
    typeof result.tokensBefore === "number" &&
    result.stats !== undefined &&
    result.parameters !== undefined &&
    result.promptVersion >= 3 &&
    (result.rung === "planned" || result.rung === "extension")
  );
}

function boundaryMessageFromResult(
  result: VerbatimCompactionResult,
): CustomMessage<VerbatimCompactionDetails> | undefined {
  if (!isCompleteCompactionResult(result)) return undefined;
  const details = {
    strategy: VERBATIM_COMPACTION_STRATEGY,
    promptVersion: result.promptVersion,
    ...(result.format === VERBATIM_COMPACTION_FORMAT_FULL ? { format: VERBATIM_COMPACTION_FORMAT_FULL } : {}),
    parameters: result.parameters,
    stats: result.stats,
    rung: result.rung,
    ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
  } satisfies VerbatimCompactionDetails;
  return createVerbatimCompactionMessage(
    result.compactedText,
    result.tokensBefore,
    new Date().toISOString(),
    details,
  ) as CustomMessage<VerbatimCompactionDetails>;
}

function customMessageText(message: CustomMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function transcriptHasBoundaryForResult(
  transcript: readonly ChatTranscriptEntryLike[],
  result: VerbatimCompactionResult,
): boolean {
  return transcript.some((entry) => {
    const candidate = entry as ChatTranscriptEntryLike & {
      readonly kind?: string;
      readonly message?: CustomMessage;
    };
    return (
      candidate.kind === "custom" &&
      candidate.message?.role === "custom" &&
      isVerbatimCompactionMessage(candidate.message) &&
      customMessageText(candidate.message).endsWith(result.compactedText)
    );
  });
}

function refreshCompactedTranscript<TExtraEntry extends ChatTranscriptEntryLike>(
  state: ChatSessionHostState<TExtraEntry>,
  result: VerbatimCompactionResult,
): void {
  const compactedMessages = state.getAgentSession?.()?.messages;
  if (compactedMessages && hasVerbatimCompactionMessage(compactedMessages)) {
    state.liveChat.replaceMessages(compactedMessages, state.extraEntries);
    return;
  }
  if (transcriptHasBoundaryForResult(state.transcript, result)) return;
  const boundary = boundaryMessageFromResult(result);
  if (boundary) state.liveChat.appendMessages([boundary]);
}

export function applyChatSessionAgentEvent<
  TExtraEntry extends ChatTranscriptEntryLike,
>(
  state: ChatSessionHostState<TExtraEntry>,
  event: AgentSessionEvent,
): boolean {
  const type = String((event as { type?: unknown }).type ?? "");
  if (type === "message_start") {
    const message = (event as { message?: unknown }).message;
    if (isUserMessageLike(message)) {
      const signature = userMessageSignature(extractMessageText(message.content));
      const count = state.optimisticUserSignatureCounts.get(signature) ?? 0;
      if (count > 0) {
        decrementOptimisticUserSignature(state, signature);
        return false;
      }
    }
  }
  if (isSharedLiveChatEvent(type)) {
    const changed = state.liveChat.applyEvent(event);
    const toolCallEvent = assistantToolCallEvent(event);
    const changedByToolCall = toolCallEvent !== undefined
      ? state.liveChat.applyEvent(toolCallEvent)
      : false;
    afterChatSessionEvent(state, changed || changedByToolCall);
    return changed || changedByToolCall;
  }
  let changed = false;
  switch (type) {
    case "agent_start":
      state.sdkBusy = true;
      state.liveChat.clearPendingTools();
      state.statusMessage = "";
      changed = true;
      break;
    case "agent_end":
      state.sdkBusy = false;
      state.workingMessage = undefined;
      state.liveChat.clearPendingTools();
      state.statusMessage = "";
      changed = true;
      break;
    case "turn_start":
      state.workingMessage = pickWhimsicalWorkingMessage();
      changed = true;
      break;
    case "turn_end":
      state.workingMessage = undefined;
      changed = true;
      break;
    case "queue_update": {
      const queue = event as { steering?: unknown; followUp?: unknown };
      state.pendingSteeringMessages = Array.isArray(queue.steering)
        ? queue.steering.filter((item): item is string => typeof item === "string")
        : [];
      state.pendingFollowUpMessages = Array.isArray(queue.followUp)
        ? queue.followUp.filter((item): item is string => typeof item === "string")
        : [];
      changed = true;
      break;
    }
    case "tool_call":
    case "tool_use":
      changed = state.liveChat.applyEvent(legacyToolStartEvent(event));
      break;
    case "tool_result":
      changed = state.liveChat.applyEvent(legacyToolResultEvent(event));
      break;
    case "thinking_delta":
    case "thinking":
      changed = state.liveChat.applyEvent(legacyThinkingEvent(event));
      break;
    case "compaction_start": {
      const compaction = event as Extract<AgentSessionEvent, { type: "compaction_start" }>;
      state.compacting = true;
      state.sdkBusy = true;
      state.statusMessage = compactionStatusMessage(compaction.reason);
      changed = true;
      break;
    }
    case "compaction_end": {
      const compaction = event as Extract<AgentSessionEvent, { type: "compaction_end" }>;
      state.compacting = false;
      state.sdkBusy = false;
      state.statusMessage = compaction.errorMessage ?? "";
      if (!compaction.aborted && !compaction.errorMessage && compaction.result) {
        refreshCompactedTranscript(state, compaction.result);
      }
      if (!compaction.aborted && !compaction.errorMessage && state.compactionQueuedMessages.length > 0) {
        void flushChatSessionCompactionQueue(state);
      }
      changed = true;
      break;
    }
    case "auto_retry_start":
      state.sdkBusy = true;
      state.statusMessage = "retrying…";
      changed = true;
      break;
    case "model_fallback_start":
      state.sdkBusy = true;
      state.statusMessage = "switching model…";
      changed = true;
      break;
    case "model_fallback_end": {
      const fallback = event as Extract<AgentSessionEvent, { type: "model_fallback_end" }>;
      state.statusMessage = fallback.success ? "" : (fallback.finalError ?? "model fallback failed");
      if (!fallback.success) {
        state.sdkBusy = false;
        state.workingMessage = undefined;
      }
      changed = true;
      break;
    }
    case "auto_retry_end": {
      const retry = event as Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
      state.statusMessage = "";
      if (!retry.success) {
        state.sdkBusy = false;
        state.workingMessage = undefined;
      }
      changed = true;
      break;
    }
    case "agent_continue_error": {
      const continueError = event as Extract<AgentSessionEvent, { type: "agent_continue_error" }>;
      state.sdkBusy = false;
      state.statusMessage = continueError.errorMessage;
      state.workingMessage = undefined;
      changed = true;
      break;
    }
    default:
      changed = false;
  }
  afterChatSessionEvent(state, changed);
  return changed;
}

function isSharedLiveChatEvent(type: string): boolean {
  return (
    type === "message_start" ||
    type === "message_update" ||
    type === "message_end" ||
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end"
  );
}

function assistantToolCallEvent(event: AgentSessionEvent): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} | undefined {
  const assistantEvent = (event as {
    assistantMessageEvent?: {
      type?: unknown;
      contentIndex?: unknown;
      partial?: unknown;
      toolCall?: unknown;
    };
  }).assistantMessageEvent;
  const streamType = String(assistantEvent?.type ?? "");
  if (!streamType.startsWith("toolcall_")) return undefined;
  const explicit = toolCallPayload(assistantEvent?.toolCall);
  if (explicit) return explicit;
  const contentIndex = typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : undefined;
  if (contentIndex === undefined) return undefined;
  const partial = assistantEvent?.partial;
  if (!isMessageLike(partial) || partial.role !== "assistant") return undefined;
  const content = partial.content;
  if (!Array.isArray(content)) return undefined;
  return toolCallPayload(content[contentIndex]);
}

function toolCallPayload(value: unknown): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
  if (candidate.type !== "toolCall") return undefined;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return undefined;
  return {
    type: "tool_execution_start",
    toolCallId: candidate.id,
    toolName: candidate.name,
    args: candidate.arguments ?? {},
  };
}

function legacyToolStartEvent(event: AgentSessionEvent): {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} {
  const payload = event as { toolCallId?: unknown; name?: unknown; input?: unknown; args?: unknown };
  const toolName = typeof payload.name === "string" ? payload.name : "tool";
  const toolCallId =
    typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: payload.input ?? payload.args ?? {},
  };
}

function legacyToolResultEvent(event: AgentSessionEvent): {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
} {
  const payload = event as {
    toolCallId?: unknown;
    name?: unknown;
    output?: unknown;
    isError?: unknown;
  };
  const toolName = typeof payload.name === "string" ? payload.name : "tool";
  const toolCallId =
    typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
  const output = payload.output;
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result:
      output !== null && typeof output === "object" && "content" in output
        ? output
        : { content: typeof output === "string" ? [{ type: "text", text: output }] : [] },
    isError: payload.isError === true,
  };
}

function legacyThinkingEvent(event: AgentSessionEvent): {
  type: "message_update";
  assistantMessageEvent: { type: "thinking_delta"; delta: string };
  message: { role: "assistant"; content: [] };
} {
  const delta = String(
    (event as { delta?: unknown }).delta ??
      (event as { text?: unknown }).text ??
      "",
  );
  return {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta },
    message: { role: "assistant", content: [] },
  };
}
