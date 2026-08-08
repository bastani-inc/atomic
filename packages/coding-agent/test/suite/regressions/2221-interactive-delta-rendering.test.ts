import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, it } from "vitest";
import {
	applyAssistantMessageDelta,
	type StreamingAssistantDelta,
} from "../../../src/modes/interactive/streaming-assistant-message.ts";

/**
 * `modes/json-event.ts` strips the cumulative `message` from wire `message_update`
 * frames. The isolated interactive engine is the DEFAULT interactive path
 * (`main.ts`: isolateInteractiveHost is true for every interactive session) and it
 * forwards those wire frames straight into the TUI, so the interactive consumer has
 * to rebuild the streaming message from deltas. When it did not, the pane rendered
 * nothing at all until `message_end` delivered the finished message.
 */
function seedMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "pending",
	} as unknown as AssistantMessage;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((entry): entry is Extract<AssistantMessage["content"][number], { type: "text" }> => entry.type === "text")
		.map((entry) => entry.text)
		.join("");
}

describe("interactive delta rendering (2221)", () => {
	it("rebuilds streaming assistant text from delta-only frames", () => {
		const message = seedMessage();
		const deltas: StreamingAssistantDelta[] = [
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello" },
			{ type: "text_delta", contentIndex: 0, delta: ", " },
			{ type: "text_delta", contentIndex: 0, delta: "world" },
		] as unknown as StreamingAssistantDelta[];

		const progression: string[] = [];
		for (const delta of deltas) {
			applyAssistantMessageDelta(message, delta);
			progression.push(textOf(message));
		}

		// The point of the fix: text is visible *while* streaming, not only at the end.
		assert.deepEqual(progression, ["", "Hello", "Hello, ", "Hello, world"]);
		assert.equal(textOf(message), "Hello, world");
	});

	it("lets text_end replace the accumulated text with the authoritative content", () => {
		const message = seedMessage();
		applyAssistantMessageDelta(message, { type: "text_start", contentIndex: 0 } as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, {
			type: "text_delta",
			contentIndex: 0,
			delta: "Hell",
		} as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, {
			type: "text_end",
			contentIndex: 0,
			content: "Hello",
		} as StreamingAssistantDelta);

		assert.equal(textOf(message), "Hello");
	});

	it("accumulates thinking deltas separately from text deltas", () => {
		const message = seedMessage();
		applyAssistantMessageDelta(message, { type: "thinking_start", contentIndex: 0 } as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "pondering",
		} as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, { type: "text_start", contentIndex: 1 } as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, {
			type: "text_delta",
			contentIndex: 1,
			delta: "answer",
		} as StreamingAssistantDelta);

		const thinking = message.content[0];
		assert.equal(thinking.type, "thinking");
		assert.equal(thinking.type === "thinking" ? thinking.thinking : "", "pondering");
		assert.equal(textOf(message), "answer");
	});

	it("installs the complete tool call at toolcall_end", () => {
		const message = seedMessage();
		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } };
		applyAssistantMessageDelta(message, { type: "toolcall_start", contentIndex: 0 } as StreamingAssistantDelta);
		// Mid-stream argument fragments are unparsable JSON and must not corrupt content.
		applyAssistantMessageDelta(message, {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"pa',
		} as StreamingAssistantDelta);
		applyAssistantMessageDelta(message, {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall,
		} as unknown as StreamingAssistantDelta);

		assert.deepEqual(message.content[0], toolCall);
	});
});
