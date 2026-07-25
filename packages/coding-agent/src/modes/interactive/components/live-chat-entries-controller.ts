import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { isSafeAssistantMessageSnapshot, isSafeMessageStartMessage } from "../../../core/message-event-validation.ts";
import { AssistantToolLifecycle } from "../assistant-tool-lifecycle.ts";
import {
  chatEntriesFromAgentMessages,
  type ChatMessageEntry,
} from "./chat-message-renderer.ts";

export interface LiveChatEventLike {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly assistantMessageEvent?: { readonly type?: unknown; readonly delta?: unknown };
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly args?: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: unknown;
  readonly assistantToolCall?: unknown;
}

type LiveChatEntry = ChatMessageEntry | { role: string };

export class LiveChatEntriesController {
  private streamingAssistantIndex: number | undefined;
  private pendingToolIndexes = new Map<string, number>();
  private readonly toolLifecycle = new AssistantToolLifecycle<number>();
  declare private readonly entries: LiveChatEntry[];

  constructor(entries: LiveChatEntry[]) {
    this.entries = entries;
  }

  appendMessages(messages: readonly AgentMessage[]): void {
    this.entries.push(...chatEntriesFromAgentMessages(messages));
    this.reindexPendingTools();
  }

  replaceMessages(
    messages: readonly AgentMessage[],
    preservedEntries: readonly { role: string }[] = [],
  ): void {
    this.entries.splice(0, this.entries.length, ...chatEntriesFromAgentMessages(messages), ...preservedEntries);
    this.streamingAssistantIndex = undefined;
    this.toolLifecycle.reset();
    this.reindexPendingTools();
  }

  appendUserText(text: string): void {
    this.entries.push({ role: "user", kind: "user", text });
  }

  applyEvent(event: LiveChatEventLike): boolean {
    const type = String(event.type ?? "");
    switch (type) {
      case "message_start":
        return this.handleMessageStart(event.message);
      case "message_update":
        return this.handleMessageUpdate(event);
      case "message_end":
        return this.handleMessageEnd(event.message);
      case "tool_execution_start":
        return this.handleToolExecutionStart(event);
      case "tool_execution_update": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (!toolCallId) return false;
        return this.updateToolResult(toolCallId, event.partialResult, true, false);
      }
      case "tool_execution_end": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (!toolCallId) return false;
        return this.updateToolResult(toolCallId, event.result, false, event.isError === true);
      }
      default:
        return false;
    }
  }

  pendingToolIds(): string[] {
    return [...this.pendingToolIndexes.keys()];
  }

  clearPendingTools(): void {
    const toolsToSettle = this.toolLifecycle.retireExecutions(this.pendingToolIndexes.keys());
    for (const [toolCallId, index] of toolsToSettle) {
      const entry = this.entries[index];
      if (!this.isToolEntry(entry) || entry.toolCallId !== toolCallId) continue;
      this.entries[index] = {
        ...entry,
        result: toolResultFromUnknown({ content: [] }, entry.toolName, toolCallId, true),
        isPartial: false,
      };
    }
    this.pendingToolIndexes.clear();
  }

  private beginAssistantLifecycle(): boolean {
    let changed = false;
    for (const [toolCallId, index] of this.toolLifecycle.beginAssistant()) {
      const entry = this.entries[index];
      if (!this.isToolEntry(entry) || entry.toolCallId !== toolCallId) continue;
      if (this.pendingToolIndexes.get(toolCallId) === index) {
        this.pendingToolIndexes.delete(toolCallId);
      }
      this.entries[index] = {
        ...entry,
        result: toolResultFromUnknown({ content: [] }, entry.toolName, toolCallId, true),
        isPartial: false,
      };
      changed = true;
    }
    return changed;
  }

  private handleMessageStart(message: unknown): boolean {
    if (!isSafeMessageStartMessage(message)) return false;
    const agentMessage = message as AgentMessage;
    if (agentMessage.role === "assistant") {
      this.beginAssistantLifecycle();
      this.streamingAssistantIndex = undefined;
      return this.updateAssistantMessage(agentMessage);
    }
    if (agentMessage.role === "toolResult") {
      const toolResult = agentMessage as ToolResultMessage;
      if (this.findToolEntryIndex(toolResult.toolCallId) >= 0) return true;
    }
    const entries = chatEntriesFromAgentMessages([agentMessage]);
    if (entries.length === 0) return false;
    this.entries.push(...entries);
    this.reindexPendingTools();
    return true;
  }

  private handleMessageUpdate(event: LiveChatEventLike): boolean {
    const message = event.message;
    if (!isSafeAssistantMessageSnapshot(message)) return false;
    const settledTools = this.beginAssistantLifecycle();
    let messageChanged = false;
    const snapshotHasPayload = assistantContentHasRenderablePayload(
      (message as { content: unknown }).content,
    );
    if (snapshotHasPayload) {
      messageChanged = this.updateAssistantMessage(message as AssistantMessage);
    }
    const assistantEvent = event.assistantMessageEvent;
    const streamType = String(assistantEvent?.type ?? "");
    const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : "";
    if (!messageChanged && streamType === "text_delta" && delta) {
      messageChanged = this.appendAssistantTextDelta(delta);
    } else if (!messageChanged && streamType === "thinking_delta" && delta) {
      messageChanged = this.appendAssistantThinkingDelta(delta);
    }
    return settledTools || messageChanged;
  }

  private handleMessageEnd(message: unknown): boolean {
    if (!isSafeAssistantMessageSnapshot(message)) {
      const role = message !== null && typeof message === "object"
        ? Reflect.get(message, "role")
        : undefined;
      const closesAssistantStream = (
        this.streamingAssistantIndex !== undefined || this.toolLifecycle.hasOpenAssistant()
      ) && (role === "assistant" || typeof role !== "string");
      if (closesAssistantStream) {
        this.streamingAssistantIndex = undefined;
        const orphaned = this.toolLifecycle.closeMalformedAssistant(
          (toolCallId, index) => this.pendingToolIndexes.get(toolCallId) === index,
        );
        for (const [toolCallId, index] of orphaned) {
          if (this.pendingToolIndexes.get(toolCallId) === index) {
            this.pendingToolIndexes.delete(toolCallId);
          }
        }
      }
      return false;
    }
    this.beginAssistantLifecycle();
    const assistantMessage = message as AssistantMessage;
    const changed = this.updateAssistantMessage(assistantMessage);
    const stopReason = assistantMessage.stopReason;
    if (stopReason === "aborted" || stopReason === "error") {
      const errorText = assistantMessage.errorMessage
        ? assistantMessage.errorMessage
        : stopReason === "aborted"
          ? "Operation aborted"
          : "Unknown error";
      for (const toolCallId of this.pendingToolIds()) {
        this.updateToolResult(
          toolCallId,
          { content: [{ type: "text", text: errorText }] },
          false,
          true,
        );
      }
      this.pendingToolIndexes.clear();
    }
    this.toolLifecycle.closeValidAssistant();
    this.streamingAssistantIndex = undefined;
    return changed || true;
  }

  private updateAssistantMessage(message: AssistantMessage): boolean {
    if (
      this.streamingAssistantIndex !== undefined &&
      this.isAssistantEntry(this.entries[this.streamingAssistantIndex])
    ) {
      this.entries[this.streamingAssistantIndex] = {
        ...(this.entries[this.streamingAssistantIndex] as Extract<ChatMessageEntry, { kind: "assistant" }>),
        message,
      };
    } else {
      this.entries.push({ role: "assistant", kind: "assistant", message });
      this.streamingAssistantIndex = this.entries.length - 1;
    }
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const startsNewGeneration = this.toolLifecycle.isRetired(content.id);
      this.upsertToolEntry({
        toolCallId: content.id,
        toolName: content.name,
        args: content.arguments,
        isPartial: true,
      }, undefined, startsNewGeneration);
      const index = this.pendingToolIndexes.get(content.id);
      if (index !== undefined) this.toolLifecycle.trackAssistantTool(content.id, index);
    }
    return true;
  }

  private appendAssistantTextDelta(delta: string): boolean {
    const current = this.currentStreamingAssistantMessage();
    const content = current ? [...current.content] : [];
    const lastText = [...content].reverse().find((item) => item.type === "text");
    if (lastText && lastText.type === "text") lastText.text += delta;
    else content.push({ type: "text", text: delta });
    return this.updateAssistantMessage({
      ...(current ?? minimalAssistantMessage()),
      content,
    });
  }

  private appendAssistantThinkingDelta(delta: string): boolean {
    const current = this.currentStreamingAssistantMessage();
    const content = current ? [...current.content] : [];
    const lastThinking = [...content].reverse().find((item) => item.type === "thinking");
    if (lastThinking && lastThinking.type === "thinking") lastThinking.thinking += delta;
    else content.push({ type: "thinking", thinking: delta });
    return this.updateAssistantMessage({
      ...(current ?? minimalAssistantMessage()),
      content,
    });
  }

  private currentStreamingAssistantMessage(): AssistantMessage | undefined {
    const entry = this.streamingAssistantIndex !== undefined
      ? this.entries[this.streamingAssistantIndex]
      : undefined;
    return this.isAssistantEntry(entry) ? entry.message : undefined;
  }

  private handleToolExecutionStart(event: LiveChatEventLike): boolean {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolCallId) return false;
    if (event.assistantToolCall === true) {
      const startsNewGeneration = this.toolLifecycle.isRetired(toolCallId);
      const changed = this.upsertToolEntry({
        toolCallId,
        toolName: typeof event.toolName === "string" ? event.toolName : "tool",
        args: event.args,
        isPartial: true,
      }, undefined, startsNewGeneration);
      const index = this.pendingToolIndexes.get(toolCallId);
      if (index !== undefined) this.toolLifecycle.trackAssistantTool(toolCallId, index);
      return changed;
    }
    const route = this.toolLifecycle.routeExecutionStart(toolCallId);
    if (route.status === "ignore") return false;
    return this.upsertToolEntry({
      toolCallId,
      toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      args: event.args,
      isPartial: true,
    }, route.status === "reclaim" ? route.tool : undefined);
  }

  private upsertToolEntry(
    update: {
      toolCallId?: string;
      toolName: string;
      args?: unknown;
      isPartial: boolean;
    },
    reclaimedIndex?: number,
    forceNew = false,
  ): boolean {
    const toolCallId = update.toolCallId ?? `live-${update.toolName}`;
    const index = forceNew
      ? -1
      : reclaimedIndex ??
        this.pendingToolIndexes.get(toolCallId) ??
        this.findToolEntryIndex(toolCallId, update.toolName);
    const previous = index >= 0 ? this.entries[index] : undefined;
    const previousTool = this.isToolEntry(previous) ? previous : undefined;
    const next: ChatMessageEntry = {
      role: "tool",
      kind: "tool",
      toolName: previousTool?.toolName ?? update.toolName,
      toolCallId,
      args: update.args ?? previousTool?.args ?? {},
      result: previousTool?.result,
      isPartial: update.isPartial,
    };
    if (index >= 0) this.entries[index] = next;
    else this.entries.push(next);
    this.pendingToolIndexes.set(toolCallId, index >= 0 ? index : this.entries.length - 1);
    return true;
  }

  private updateToolResult(
    toolCallId: string,
    result: unknown,
    isPartial: boolean,
    isError: boolean,
  ): boolean {
    const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId);
    if (index < 0) return false;
    const entry = this.entries[index];
    if (!this.pendingToolIndexes.has(toolCallId) && this.toolLifecycle.blocksUnroutedExecution(toolCallId)) {
      return false;
    }
    if (!this.isToolEntry(entry)) return false;
    const resultObject = toolResultFromUnknown(result, entry.toolName, toolCallId, isError);
    this.entries[index] = { ...entry, result: resultObject, isPartial };
    if (!isPartial) {
      this.pendingToolIndexes.delete(toolCallId);
      this.toolLifecycle.completeExecution(toolCallId);
    }
    return true;
  }

  private isSyntheticToolCallId(toolCallId: string): boolean {
    return toolCallId.startsWith("live-");
  }

  private findToolEntryIndex(toolCallId: string, toolName?: string): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!this.isToolEntry(entry)) continue;
      if (entry.toolCallId === toolCallId) return i;
      if (
        toolName &&
        entry.toolName === toolName &&
        entry.isPartial !== false &&
        (this.isSyntheticToolCallId(toolCallId) || this.isSyntheticToolCallId(entry.toolCallId))
      ) {
        return i;
      }
    }
    return -1;
  }

  private reindexPendingTools(): void {
    this.pendingToolIndexes.clear();
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (
        this.isToolEntry(entry) &&
        entry.isPartial !== false &&
        !this.toolLifecycle.blocksUnroutedExecution(entry.toolCallId)
      ) {
        this.pendingToolIndexes.set(entry.toolCallId, i);
      }
    }
  }

  private isAssistantEntry(
    entry: LiveChatEntry | undefined,
  ): entry is Extract<ChatMessageEntry, { kind: "assistant" }> {
    return isChatMessageEntry(entry) && entry.kind === "assistant";
  }

  private isToolEntry(
    entry: LiveChatEntry | undefined,
  ): entry is Extract<ChatMessageEntry, { kind: "tool" }> {
    return isChatMessageEntry(entry) && entry.kind === "tool";
  }
}

function isChatMessageEntry(entry: LiveChatEntry | undefined): entry is ChatMessageEntry {
  return entry !== undefined && "kind" in entry;
}

function assistantContentHasRenderablePayload(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (typeof item === "string") return item.length > 0;
    if (item == null || typeof item !== "object") return false;
    const obj = item as { type?: unknown; text?: unknown; thinking?: unknown };
    return (
      (obj.type === "text" && typeof obj.text === "string" && obj.text.length > 0) ||
      (obj.type === "thinking" && typeof obj.thinking === "string" && obj.thinking.length > 0) ||
      obj.type === "toolCall"
    );
  });
}

function minimalAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
  } as unknown as AssistantMessage;
}

function toolResultFromUnknown(
  result: unknown,
  toolName: string,
  toolCallId: string,
  isError: boolean,
): ToolResultMessage {
  if (result !== null && typeof result === "object" && "content" in result) {
    const candidate = result as { content?: unknown; details?: unknown };
    const content = Array.isArray(candidate.content) ? candidate.content : [];
    return {
      role: "toolResult",
      toolCallId,
      toolName,
      content: content as ToolResultMessage["content"],
      details: candidate.details,
      isError,
      timestamp: Date.now(),
    };
  }
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: typeof result === "string" ? [{ type: "text", text: result }] : [],
    isError,
    timestamp: Date.now(),
  };
}
