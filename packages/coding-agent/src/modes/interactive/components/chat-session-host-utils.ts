import { matchesKey as tuiMatchesKey } from "@earendil-works/pi-tui";
import type { ChatMessageEntry } from "./chat-message-renderer.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";
import type {
  CacheKeyPart,
  ChatSessionHostEntry,
} from "./chat-session-host-types.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const ANIMATION_FRAME_MS = 80;
export const STREAMING_RENDER_THROTTLE_MS = 80;
const STREAMING_TEXT_TAIL_LINES = 240;
const STREAMING_TEXT_TAIL_CHARS = 16_000;

export function matchesKey(
  data: string,
  key: "enter" | "backspace" | "escape" | "ctrl+f" | "alt+up",
): boolean {
  if (key === "enter" && (data === "\r" || data === "\n")) return true;
  if (key === "backspace" && (data === "\x7f" || data === "\b")) return true;
  if (key === "escape" && data === "\x1b") return true;
  if (key === "ctrl+f" && data === "\x06") return true;
  return tuiMatchesKey(data, key);
}

export function parseBashInput(text: string):
  | { command: string; excludeFromContext: boolean }
  | undefined {
  if (!text.startsWith("!")) return undefined;
  const excludeFromContext = text.startsWith("!!");
  const command = text.slice(excludeFromContext ? 2 : 1).trim();
  return { command, excludeFromContext };
}

export function cacheKey(parts: readonly CacheKeyPart[]): string {
  return JSON.stringify(parts);
}

export function isChatMessageEntry<TExtraEntry extends ChatTranscriptEntryLike>(
  entry: ChatSessionHostEntry<TExtraEntry>,
): entry is ChatMessageEntry {
  if (!("role" in entry) || !("kind" in entry)) return false;
  const candidate = entry as { role?: unknown; kind?: unknown; message?: unknown; text?: unknown };
  switch (candidate.kind) {
    case "assistant":
      return candidate.role === "assistant" && candidate.message !== undefined;
    case "tool":
      return candidate.role === "tool" && "toolName" in candidate && "toolCallId" in candidate && "args" in candidate;
    case "bashExecution":
      return candidate.role === "tool" && candidate.message !== undefined;
    case "user":
      return candidate.role === "user" && typeof candidate.text === "string";
    case "custom":
      return candidate.role === "custom" && candidate.message !== undefined;
    case "branchSummary":
      return candidate.role === "summary" && candidate.message !== undefined;
    case "system":
      return candidate.role === "system" && candidate.message !== undefined;
    default:
      return false;
  }
}

export function isMessageLike(message: unknown): message is { role?: unknown; content?: unknown } {
  return message !== null && typeof message === "object" && "role" in message;
}

export function isUserMessageLike(
  message: unknown,
): message is { role: "user"; content?: unknown } {
  return isMessageLike(message) && message.role === "user";
}

export function userMessageSignature(text: string): string {
  return text.trim();
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const obj = item as { type?: unknown; text?: unknown };
    if (typeof obj.text === "string") parts.push(obj.text);
    else if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("");
}

export function tailStreamingText(text: string): string {
  if (
    text.length <= STREAMING_TEXT_TAIL_CHARS &&
    text.split("\n").length <= STREAMING_TEXT_TAIL_LINES
  ) {
    return text;
  }
  const byChars = text.slice(-STREAMING_TEXT_TAIL_CHARS);
  const lines = byChars.split("\n");
  const tail =
    lines.length > STREAMING_TEXT_TAIL_LINES
      ? lines.slice(-STREAMING_TEXT_TAIL_LINES).join("\n")
      : byChars;
  return `[earlier streaming output hidden while attached]\n\n${tail.trimStart()}`;
}

export function spinnerFrame(): string {
  const idx = Math.floor(Date.now() / ANIMATION_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx]!;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
