import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { JsonAgentSessionEvent } from "../json-event.ts";

type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/** The delta payload a wire `message_update` frame carries, with `partial` stripped. */
export type StreamingAssistantDelta = JsonMessageUpdateEvent["assistantMessageEvent"];

type AssistantContent = AssistantMessage["content"][number];
type TextContent = Extract<AssistantContent, { type: "text" }>;
type ThinkingContent = Extract<AssistantContent, { type: "thinking" }>;

function placeContent(content: AssistantContent[], index: number, entry: AssistantContent): void {
	while (content.length <= index) content.push({ type: "text", text: "" });
	content[index] = entry;
}

function textAt(content: AssistantContent[], index: number): TextContent {
	const existing = content[index];
	if (existing?.type === "text") return existing;
	const created: TextContent = { type: "text", text: "" };
	placeContent(content, index, created);
	return created;
}

function thinkingAt(content: AssistantContent[], index: number): ThinkingContent {
	const existing = content[index];
	if (existing?.type === "thinking") return existing;
	const created: ThinkingContent = { type: "thinking", thinking: "" };
	placeContent(content, index, created);
	return created;
}

/**
 * Apply one streaming delta to the assistant message being rendered.
 *
 * Public consumers receive delta-only `message_update` events: `message_start`
 * seeds the message, the deltas build it, and `message_end` supplies the final
 * authoritative message. Interactive consumers apply the deltas here so they
 * can render incrementally without a cumulative snapshot.
 *
 * Returns whether the message changed, so the caller can skip a redraw when it did not.
 * `toolcall_start`/`toolcall_delta` carry an unparsable JSON argument fragment and are
 * deliberately ignored: the tool card is created by `tool_execution_start`, and
 * `toolcall_end` installs the complete, parsed call.
 */
export function applyAssistantMessageDelta(message: AssistantMessage, event: StreamingAssistantDelta): boolean {
	const content = message.content;
	switch (event.type) {
		case "text_start":
			textAt(content, event.contentIndex).text = "";
			return true;
		case "text_delta":
			textAt(content, event.contentIndex).text += event.delta;
			return true;
		case "text_end":
			textAt(content, event.contentIndex).text = event.content;
			return true;
		case "thinking_start":
			thinkingAt(content, event.contentIndex).thinking = "";
			return true;
		case "thinking_delta":
			thinkingAt(content, event.contentIndex).thinking += event.delta;
			return true;
		case "thinking_end":
			thinkingAt(content, event.contentIndex).thinking = event.content;
			return true;
		case "toolcall_end":
			placeContent(content, event.contentIndex, event.toolCall);
			return true;
		default:
			return false;
	}
}
