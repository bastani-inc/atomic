import type { AgentSession } from "@bastani/atomic";
import { errorMessage } from "../shared/model-fallback.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

type TextLikeContent = {
  readonly type?: string;
  readonly text?: string;
};

type MessageWithTextContent = {
  readonly content?: string | readonly TextLikeContent[];
};

export function extractMessageText(message: AgentSession["messages"][number]): string {
  const { content } = message as MessageWithTextContent;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function lastAssistantTextFromMessages(messages: AgentSession["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = extractMessageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function messageStopReason(message: AgentSession["messages"][number]): string | undefined {
  const record = message as { readonly stopReason?: unknown };
  return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

function normalizedStopReason(stopReason: string | undefined): string | undefined {
  return stopReason?.toLowerCase().replace(/[_-]+/g, "");
}

function isTerminalAssistantFailureStopReason(stopReason: string | undefined): boolean {
  const normalized = normalizedStopReason(stopReason);
  return normalized === "error" || normalized === "aborted";
}

function isCleanAssistantStopReason(stopReason: string | undefined): boolean {
  const normalized = normalizedStopReason(stopReason);
  return normalized === "stop" || normalized === "tooluse" || normalized === "length";
}

function assistantErrorMessage(message: AgentSession["messages"][number]): string | undefined {
  const record = message as { readonly errorMessage?: unknown };
  return typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0
    ? record.errorMessage
    : undefined;
}

export function latestTerminalAssistantFailureSince(
  messages: AgentSession["messages"],
  startIndex: number,
): AgentSession["messages"][number] | undefined {
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const stopReason = messageStopReason(message);
    if (isTerminalAssistantFailureStopReason(stopReason)) return message;
    if (isCleanAssistantStopReason(stopReason)) return undefined;
    if (assistantErrorMessage(message) === undefined && extractMessageText(message).trim().length > 0) {
      return undefined;
    }
  }
  return undefined;
}

export class WorkflowPromptModelFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "WorkflowPromptModelFailure";
    this.cause = cause;
  }
}

function terminatingToolResultText(
  messages: AgentSession["messages"],
  terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string" || !terminatingToolCallIds.has(toolCallId)) {
        return undefined;
      }
      const text = extractMessageText(message).trim();
      return text.length > 0 ? text : undefined;
    }
    if (message.role === "assistant") return undefined;
  }
  return undefined;
}

export function lastAssistantTextFromSession(
  activeSession: StageSessionRuntime | undefined,
  fallback: string | undefined,
  terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
  if (!activeSession) return fallback;
  const terminatingText = terminatingToolResultText(activeSession.messages, terminatingToolCallIds);
  if (terminatingText !== undefined) return terminatingText;
  const direct = activeSession.getLastAssistantText?.();
  if (direct !== undefined && direct.trim()) return direct;
  return lastAssistantTextFromMessages(activeSession.messages) ?? direct ?? fallback;
}

export function assistantMessage(text: string): AgentSession["messages"] {
  return [
    {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  ] as AgentSession["messages"];
}
