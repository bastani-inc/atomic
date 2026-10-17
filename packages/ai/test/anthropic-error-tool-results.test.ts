import assert from "node:assert/strict";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages.js";
import { test } from "vitest";
import { streamSimple } from "../src/compat.js";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types.js";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function toolResult(
	toolCallId: string,
	toolName: string,
	content: ToolResultMessage["content"],
	isError: boolean,
): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: 0 };
}

function assistantCalling(...results: ToolResultMessage[]): AssistantMessage {
	return {
		role: "assistant",
		content: results.map((result) => ({
			type: "toolCall" as const,
			id: result.toolCallId,
			name: result.toolName,
			arguments: {},
		})),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

/** Returns the user message that carries the tool results of the turn. */
async function captureToolResultMessage(...results: ToolResultMessage[]) {
	const original = structuredClone(results);
	const context: Context = {
		messages: [{ role: "user", content: "Show an image", timestamp: 0 }, assistantCalling(...results), ...results],
	};
	let payload: MessageCreateParams | undefined;
	await streamSimple(model, context, {
		apiKey: "fake-key",
		cacheRetention: "none",
		onPayload: (value) => {
			payload = value as MessageCreateParams;
			throw new Error("payload captured");
		},
	}).result();
	assert.deepEqual(results, original);
	assert.ok(payload);
	const message = payload.messages.at(-1);
	assert.ok(message && typeof message.content !== "string");
	return message.content;
}

const image = (data: string): ToolResultMessage["content"][number] => ({ type: "image", data, mimeType: "image/png" });
const wireImage = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const attachedNote = "(image attached after the tool results)";

test("moves images of Anthropic error tool results after the tool results of the turn (#10794)", async () => {
	const content = await captureToolResultMessage(
		toolResult(
			"call-1",
			"codemode",
			[
				{ type: "text", text: "Script failed" },
				image("AAAA"),
				image("CCCC"),
				{ type: "text", text: "Script error" },
			],
			true,
		),
		toolResult("call-2", "read", [image("BBBB")], false),
	);
	assert.deepEqual(content, [
		{
			type: "tool_result",
			tool_use_id: "call-1",
			content: `Script failed\n${attachedNote}\nScript error`,
			is_error: true,
		},
		{
			type: "tool_result",
			tool_use_id: "call-2",
			content: [{ type: "text", text: "(see attached image)" }, wireImage("BBBB")],
			is_error: false,
		},
		{ type: "text", text: "Images from the error result of tool call call-1 (codemode):" },
		wireImage("AAAA"),
		wireImage("CCCC"),
	]);
});

test("keeps images in successful Anthropic tool results", async () => {
	const content = await captureToolResultMessage(
		toolResult("call_image", "show_image", [{ type: "text", text: "Image shown" }, image("aW1hZ2U=")], false),
	);
	assert.deepEqual(content, [
		{
			type: "tool_result",
			tool_use_id: "call_image",
			content: [{ type: "text", text: "Image shown" }, wireImage("aW1hZ2U=")],
			is_error: false,
		},
	]);
});

test("keeps Anthropic error tool results without images unchanged", async () => {
	const content = await captureToolResultMessage(
		toolResult("call_image", "show_image", [{ type: "text", text: "Script failed" }], true),
	);
	assert.deepEqual(content, [
		{ type: "tool_result", tool_use_id: "call_image", content: "Script failed", is_error: true },
	]);
});

test("serializes image-only Anthropic error tool results as the attachment note (#10794)", async () => {
	const content = await captureToolResultMessage(toolResult("call_image", "show_image", [image("aW1hZ2U=")], true));
	assert.deepEqual(content, [
		{ type: "tool_result", tool_use_id: "call_image", content: attachedNote, is_error: true },
		{ type: "text", text: "Images from the error result of tool call call_image (show_image):" },
		wireImage("aW1hZ2U="),
	]);
});
