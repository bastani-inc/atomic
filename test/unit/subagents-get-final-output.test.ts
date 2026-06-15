import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../packages/subagents/src/shared/utils.js";

function assistantContent(content: unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

function toolResultContent(toolName: string, content: unknown[], isError = false): Message {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content,
		isError,
	} as unknown as Message;
}

describe("subagents getFinalOutput", () => {
	test("uses the last non-empty text part in the latest assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "" },
			{ type: "text", text: "Summary" },
		])];

		assert.equal(getFinalOutput(messages), "Summary");
	});

	test("prefers final text over progress text in a multi-part assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "Working on the fix..." },
			{ type: "thinking", thinking: "Cursor shell: shell $ npm test" },
			{ type: "text", text: "Implemented: patch applied." },
		])];

		assert.equal(getFinalOutput(messages), "Implemented: patch applied.");
	});

	test("falls back to an older assistant message when latest text is whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "text", text: " \n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	test("falls back to an older assistant message when latest assistant message is tool-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "toolCall", name: "read", arguments: { path: "README.md" } }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	test("returns empty output when all assistant text is empty or whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "" }]),
			assistantContent([{ type: "text", text: "\n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	test("does not use provider-error assistant text as fallback output", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "temporary provider failure" }],
				stopReason: "error",
				errorMessage: "provider transport failed",
			} as unknown as Message,
			assistantContent([{ type: "text", text: "" }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	test("preserves surrounding whitespace on the selected non-empty text", () => {
		const messages = [assistantContent([{ type: "text", text: " \n Summary \n " }])];

		assert.equal(getFinalOutput(messages), " \n Summary \n ");
	});

	test("uses trailing structured_output tool result text when no assistant follow-up exists", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier prose" }]),
			assistantContent([{ type: "toolCall", id: "call-1", name: "structured_output", arguments: { status: "ok" } }]),
			toolResultContent("structured_output", [
				{ type: "image", data: "ignored", mimeType: "image/png" },
				{ type: "text", text: '{"status":' },
				{ type: "text", text: '"ok"}' },
			]),
		];

		assert.equal(getFinalOutput(messages), '{"status":"ok"}');
	});

	test("ignores final non-structured tool results and falls back to assistant text", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier prose" }]),
			toolResultContent("read", [{ type: "text", text: "file contents" }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier prose");
	});

	test("does not let an earlier structured_output result override later assistant text", () => {
		const messages = [
			assistantContent([{ type: "toolCall", id: "call-1", name: "structured_output", arguments: { status: "ok" } }]),
			toolResultContent("structured_output", [{ type: "text", text: '{"status":"ok"}' }]),
			assistantContent([{ type: "text", text: "Final prose" }]),
		];

		assert.equal(getFinalOutput(messages), "Final prose");
	});

	test("ignores error structured_output tool results and falls back to assistant text", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier prose" }]),
			toolResultContent("structured_output", [{ type: "text", text: '{"status":"bad"}' }], true),
		];

		assert.equal(getFinalOutput(messages), "Earlier prose");
	});

	test("falls back when the final structured_output tool result has no text content", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier prose" }]),
			toolResultContent("structured_output", [
				{ type: "image", data: "ignored", mimeType: "image/png" },
				{ type: "text", text: " \n\t " },
			]),
		];

		assert.equal(getFinalOutput(messages), "Earlier prose");
	});
});
