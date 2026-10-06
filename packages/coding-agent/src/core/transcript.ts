import type { JsonObject, JsonValue } from "@bastani/pi-ai";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import {
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
} from "../modes/interactive/streaming-assistant-message.ts";
import type { AgentSessionEvent } from "./agent-session-types.ts";

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
	/** The result's `details`, or `null` when it had none. Set when the tool reports `"details"`. */
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

interface RawToolResult {
	toolName: string;
	result: unknown;
	isError: boolean;
	isPartial: boolean;
}

/** A detached, JSON-shaped copy, so callers cannot mutate transcript state and parts always serialize. */
function toJson(value: unknown): JsonValue {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? null : (JSON.parse(text) as JsonValue);
	} catch {
		return null;
	}
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
	const messages: AssistantMessage[] = [];
	const results = new Map<string, RawToolResult>();
	let streaming: AssistantMessage | undefined;

	const settle = (message: AssistantMessage): void => {
		if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
		const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Unknown error");
		for (const block of message.content) {
			if (block.type !== "toolCall" || results.get(block.id)?.isPartial === false) continue;
			results.set(block.id, {
				toolName: block.name,
				result: { content: [{ type: "text", text }] },
				isError: true,
				isPartial: false,
			});
		}
	};

	const toolResult = (toolName: string, raw: RawToolResult): TranscriptToolResult => {
		const value = raw.result as { content?: unknown; details?: unknown } | string | null | undefined;
		if ((options.toolResult?.(toolName) ?? "content") === "details") {
			const details = typeof value === "object" && value !== null ? value.details : undefined;
			return { details: toJson(details), isError: raw.isError, isPartial: raw.isPartial };
		}
		let content = typeof value === "string" ? value : "";
		if (typeof value === "object" && value !== null && Array.isArray(value.content)) {
			content = value.content
				.filter((item): item is { type: "text"; text: string } => item?.type === "text")
				.map((item) => item.text)
				.join("\n");
		}
		return { content, isError: raw.isError, isPartial: raw.isPartial };
	};

	return {
		apply(event) {
			if ("parentToolCallId" in event && typeof event.parentToolCallId === "string") return;
			switch (event.type) {
				case "message_start":
					if (event.message.role !== "assistant") return;
					streaming = beginStreamingAssistantMessage(event.message);
					messages.push(streaming);
					return;
				case "message_update":
					if (!streaming) {
						streaming = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
						messages.push(streaming);
					}
					applyAssistantMessageDelta(streaming, event.assistantMessageEvent);
					return;
				case "message_end": {
					if (event.message.role !== "assistant") return;
					const final = beginStreamingAssistantMessage(event.message);
					const index = streaming ? messages.indexOf(streaming) : -1;
					if (index >= 0) messages[index] = final;
					else messages.push(final);
					streaming = undefined;
					settle(final);
					return;
				}
				case "tool_execution_update":
					if (results.get(event.toolCallId)?.isPartial === false) return;
					results.set(event.toolCallId, {
						toolName: event.toolName,
						result: event.partialResult,
						isError: false,
						isPartial: true,
					});
					return;
				case "tool_execution_end":
					results.set(event.toolCallId, {
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
						isPartial: false,
					});
					return;
			}
		},
		parts() {
			const parts: TranscriptPart[] = [];
			for (const message of messages) {
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
