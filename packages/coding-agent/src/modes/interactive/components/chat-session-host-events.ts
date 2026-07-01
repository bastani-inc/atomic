import type { AgentSessionEvent } from "../../../core/agent-session.ts";
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
    case "compaction_start":
    case "context_compaction_start":
      state.compacting = true;
      state.sdkBusy = true;
      state.statusMessage = "compacting context…";
      changed = true;
      break;
    case "compaction_end": {
      const compaction = event as Extract<AgentSessionEvent, { type: "compaction_end" }>;
      state.compacting = false;
      state.sdkBusy = false;
      state.statusMessage = compaction.errorMessage ?? "";
      if (!compaction.aborted && !compaction.errorMessage && state.compactionQueuedMessages.length > 0) {
        void flushChatSessionCompactionQueue(state);
      }
      changed = true;
      break;
    }
    case "context_compaction_end": {
      const compaction = event as Extract<AgentSessionEvent, { type: "context_compaction_end" }>;
      state.compacting = false;
      state.sdkBusy = false;
      state.statusMessage = compaction.errorMessage ?? "";
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
