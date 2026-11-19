import { matchesKey as tuiMatchesKey } from "@bastani/atomic-tui";
import type { ChatMessageEntry } from "./chat-message-renderer.ts";
import type { CacheKeyPart, ChatSessionHostEntry } from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const ANIMATION_FRAME_MS = 80;
const STREAMING_TEXT_TAIL_LINES = 240;
const STREAMING_TEXT_TAIL_CHARS = 16_000;

export function matchesKey(data: string, key: "enter" | "backspace" | "escape" | "ctrl+f" | "alt+up"): boolean {
	if (key === "enter" && (data === "\r" || data === "\n")) return true;
	if (key === "backspace" && (data === "\x7f" || data === "\b")) return true;
	if (key === "escape" && data === "\x1b") return true;
	if (key === "ctrl+f" && data === "\x06") return true;
	return tuiMatchesKey(data, key);
}

export function parseBashInput(text: string): { command: string; excludeFromContext: boolean } | undefined {
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
		case "task":
			return candidate.role === "tool" && "task" in candidate;
		case "assistant":
			return candidate.role === "assistant" && candidate.message !== undefined;
		case "tool":
			return (
				candidate.role === "tool" && "toolName" in candidate && "toolCallId" in candidate && "args" in candidate
			);
		case "bashExecution":
			return candidate.role === "tool" && candidate.message !== undefined;
		case "user":
			return candidate.role === "user" && typeof candidate.text === "string";
		case "custom":
			return candidate.role === "custom" && candidate.message !== undefined;
		case "branchSummary":
			return candidate.role === "summary" && candidate.message !== undefined;
		case "system":
			return candidate.role === "system" && typeof candidate.text === "string";
		default:
			return false;
	}
}

export function isMessageLike(message: unknown): message is { role?: unknown; content?: unknown } {
	return message !== null && typeof message === "object" && "role" in message;
}

export function isUserMessageLike(message: unknown): message is { role: "user"; content?: unknown } {
	return isMessageLike(message) && message.role === "user";
}

export function exactTextOnlyUserPrompt(message: unknown): string | undefined {
	if (!isUserMessageLike(message)) return undefined;
	const content = message.content;
	if (typeof content === "string") {
		return content.trim().length > 0 ? content : undefined;
	}
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "text") return undefined;
		const text = (part as { text?: unknown }).text;
		if (typeof text !== "string") return undefined;
		parts.push(text);
	}
	const joined = parts.join("");
	return joined.trim().length > 0 ? joined : undefined;
}

export function firstRawUserExactText(messages: readonly unknown[]): {
	readonly seenUser: boolean;
	readonly exactText: string | undefined;
} {
	for (const message of messages) {
		if (!isUserMessageLike(message)) continue;
		return { seenUser: true, exactText: exactTextOnlyUserPrompt(message) };
	}
	return { seenUser: false, exactText: undefined };
}

export function syncFirstUserEntry<TExtraEntry extends ChatTranscriptEntryLike>(state: {
	readonly transcript: readonly ChatSessionHostEntry<TExtraEntry>[];
	firstUserEntry: Extract<ChatMessageEntry, { kind: "user" }> | undefined;
}): void {
	for (const entry of state.transcript) {
		if (isChatMessageEntry(entry) && entry.kind === "user") {
			state.firstUserEntry = entry;
			return;
		}
	}
	state.firstUserEntry = undefined;
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
	}
	return parts.join("");
}

export function tailStreamingText(text: string): string {
	if (text.length <= STREAMING_TEXT_TAIL_CHARS && text.split("\n").length <= STREAMING_TEXT_TAIL_LINES) {
		return text;
	}
	const byChars = text.slice(-STREAMING_TEXT_TAIL_CHARS);
	const lines = byChars.split("\n");
	const tail = lines.length > STREAMING_TEXT_TAIL_LINES ? lines.slice(-STREAMING_TEXT_TAIL_LINES).join("\n") : byChars;
	return `[earlier streaming output hidden while attached]\n\n${tail.trimStart()}`;
}

export function spinnerFrame(): string {
	const idx = Math.floor(Date.now() / ANIMATION_FRAME_MS) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[idx]!;
}

/** `s` without CSI sequences and APC markers, such as a clickable key hint's. */
export function stripAnsi(s: string): string {
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x1B_[^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
