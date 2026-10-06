import type { JsonObject, JsonValue } from "@bastani/pi-ai";
import type { AssistantMessage, TextContent } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
} from "../modes/interactive/streaming-assistant-message.ts";
import type { AgentSessionEvent } from "./agent-session-types.js";

/** Assistant prose. */
export interface TranscriptTextPart {
	type: "text";
	text: string;
}

/** Visible assistant reasoning. Redacted thinking blocks are never reported. */
export interface TranscriptThinkingPart {
	type: "thinking";
	thinking: string;
}

/** The latest result reported for a tool call. */
export interface TranscriptToolResult {
	/** Text content of the result, joined with newlines. Set when the tool reports `"content"`. */
	content?: string;
	/**
	 * The result's `details`, or `null` when it had none. Set when the tool reports `"details"`.
	 * A failed call without details also carries its error text in `content`.
	 */
	details?: JsonValue;
	isError: boolean;
	/** True while the result comes from `tool_execution_update` and the tool is still running. */
	isPartial: boolean;
}

/** A tool call from assistant content, joined by id with its execution result. */
export interface TranscriptToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	/** Absent until the tool reports an update or finishes. */
	result?: TranscriptToolResult;
}

export type TranscriptPart = TranscriptTextPart | TranscriptThinkingPart | TranscriptToolCallPart;

/** Which field of a tool result to report: its text content (the default) or its `details`. */
export type TranscriptToolResultFormat = "content" | "details";

export interface TranscriptOptions {
	/** Choose per tool whether `result.content` or `result.details` is reported. Defaults to `"content"`. */
	toolResult?: (toolName: string) => TranscriptToolResultFormat;
}

export interface Transcript {
	/** Feed one session event. Events from nested tool calls (`parentToolCallId`) are ignored. */
	apply(event: AgentSessionEvent): void;
	/** Ordered parts of every assistant message seen so far, including the one still streaming. */
	parts(): TranscriptPart[];
}

/** What a tool reports as its result; anything else reports empty content and no details. */
type ToolResultValue = Partial<AgentToolResult> | string | null | undefined;

interface RawToolResult {
	result: ToolResultValue;
	isError: boolean;
	isPartial: boolean;
}

/** One assistant message and the results bound to its tool calls, keyed by call id. */
interface MessageEntry {
	message: AssistantMessage;
	results: Map<string, RawToolResult>;
}

/** A detached, JSON-shaped copy, so callers cannot mutate transcript state and parts always serialize. */
function toJson(value: JsonValue | undefined): JsonValue {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? null : (JSON.parse(text) as JsonValue);
	} catch {
		return null;
	}
}

function hasToolCall(message: AssistantMessage, id: string): boolean {
	return message.content.some((block) => block.type === "toolCall" && block.id === id);
}

/**
 * Reduce session events into the assistant's output as plain JSON parts.
 *
 * ```ts
 * const transcript = createTranscript();
 * session.subscribe((event) => transcript.apply(event));
 * transcript.parts();
 * ```
 */
export function createTranscript(options: TranscriptOptions = {}): Transcript {
	const entries: MessageEntry[] = [];
	/** Results that arrived before any assistant message held their tool call. */
	const unbound = new Map<string, RawToolResult>();
	let streaming: MessageEntry | undefined;

	/** Bind to the most recent call with this id that has no final result, so reused ids keep separate results. */
	const record = (id: string, raw: RawToolResult): void => {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!hasToolCall(entry.message, id) || entry.results.get(id)?.isPartial === false) continue;
			entry.results.set(id, raw);
			return;
		}
		if (raw.isPartial && unbound.get(id)?.isPartial === false) return;
		unbound.set(id, raw);
	};

	const adopt = (entry: MessageEntry): void => {
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || entry.results.has(block.id)) continue;
			const raw = unbound.get(block.id);
			if (!raw) continue;
			entry.results.set(block.id, raw);
			unbound.delete(block.id);
		}
	};

	const settle = (entry: MessageEntry): void => {
		const message = entry.message;
		if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
		const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Unknown error");
		for (const block of message.content) {
			if (block.type !== "toolCall" || entry.results.get(block.id)?.isPartial === false) continue;
			entry.results.set(block.id, {
				result: { content: [{ type: "text", text }] },
				isError: true,
				isPartial: false,
			});
		}
	};

	const toolResult = (toolName: string, raw: RawToolResult): TranscriptToolResult => {
		const value = raw.result;
		let content = typeof value === "string" ? value : "";
		if (typeof value === "object" && value !== null && Array.isArray(value.content)) {
			content = value.content
				.filter((item): item is TextContent => item?.type === "text")
				.map((item) => item.text)
				.join("\n");
		}
		if ((options.toolResult?.(toolName) ?? "content") === "details") {
			const details = toJson(typeof value === "object" && value !== null ? value.details : undefined);
			const errorText = raw.isError && details === null && content !== "" ? { content } : {};
			return { details, ...errorText, isError: raw.isError, isPartial: raw.isPartial };
		}
		return { content, isError: raw.isError, isPartial: raw.isPartial };
	};

	return {
		apply(event) {
			if ("parentToolCallId" in event && typeof event.parentToolCallId === "string") return;
			switch (event.type) {
				case "message_start":
					if (event.message.role !== "assistant") return;
					streaming = { message: beginStreamingAssistantMessage(event.message), results: new Map() };
					entries.push(streaming);
					return;
				case "message_update": {
					if (!streaming) {
						streaming = {
							message: {
								role: "assistant",
								content: [],
								api: "",
								provider: "",
								model: "",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
								timestamp: Date.now(),
							},
							results: new Map(),
						};
						entries.push(streaming);
					}
					const delta = event.assistantMessageEvent;
					applyAssistantMessageDelta(streaming.message, delta);
					if (
						delta.type === "thinking_start" ||
						delta.type === "thinking_delta" ||
						delta.type === "thinking_end"
					) {
						// Deltas do not carry the redaction flag; the provider's partial does.
						const source = delta.partial?.content[delta.contentIndex];
						const block = streaming.message.content[delta.contentIndex];
						if (source?.type === "thinking" && source.redacted && block?.type === "thinking")
							block.redacted = true;
					}
					adopt(streaming);
					return;
				}
				case "message_end": {
					if (event.message.role !== "assistant") return;
					const message = beginStreamingAssistantMessage(event.message);
					const entry = streaming ?? { message, results: new Map<string, RawToolResult>() };
					if (streaming) entry.message = message;
					else entries.push(entry);
					streaming = undefined;
					adopt(entry);
					settle(entry);
					return;
				}
				case "tool_execution_update":
					record(event.toolCallId, { result: event.partialResult, isError: false, isPartial: true });
					return;
				case "tool_execution_end":
					record(event.toolCallId, { result: event.result, isError: event.isError, isPartial: false });
					return;
			}
		},
		parts() {
			const parts: TranscriptPart[] = [];
			for (const { message, results } of entries) {
				for (const block of message.content) {
					if (block.type === "text") {
						if (block.text) parts.push({ type: "text", text: block.text });
					} else if (block.type === "thinking") {
						if (!block.redacted && block.thinking) parts.push({ type: "thinking", thinking: block.thinking });
					} else if (block.type === "toolCall") {
						const raw = results.get(block.id);
						const part: TranscriptToolCallPart = {
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: toJson(block.arguments) as JsonObject,
						};
						if (raw) part.result = toolResult(block.name, raw);
						parts.push(part);
					}
				}
			}
			return parts;
		},
	};
}
