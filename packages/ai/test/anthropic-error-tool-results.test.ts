import assert from "node:assert/strict";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages.js";
import { test } from "vitest";
import { streamSimple } from "../src/compat.js";
import type { Context, Model, ToolResultMessage } from "../src/types.js";

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

async function captureToolResult(content: ToolResultMessage["content"], isError: boolean) {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_image",
		toolName: "show_image",
		content,
		isError,
		timestamp: 0,
	};
	const original = structuredClone(toolResult);
	const context: Context = {
		messages: [
			{ role: "user", content: "Show an image", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_image", name: "show_image", arguments: {} }],
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
			},
			toolResult,
		],
	};
	let payload: MessageCreateParams | undefined;
	await streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (value) => {
			payload = value as MessageCreateParams;
			throw new Error("payload captured");
		},
	}).result();
	assert.deepEqual(toolResult, original);
	assert.ok(payload);
	const blocks = payload.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content));
	const result = blocks.find((block) => block.type === "tool_result");
	assert.ok(result);
	assert.equal(result.tool_use_id, "call_image");
	assert.equal(result.is_error, isError);
	return result.content;
}

const image: ToolResultMessage["content"][number] = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const omittedImage = "[image omitted: error tool results cannot contain images]";

test("replaces images with text in Anthropic error tool results (#10794)", async () => {
	assert.equal(
		await captureToolResult(
			[{ type: "text", text: "Before failure" }, image, { type: "text", text: "After failure" }, image],
			true,
		),
		`Before failure\n${omittedImage}\nAfter failure\n${omittedImage}`,
	);
});

test("keeps images in successful Anthropic tool results", async () => {
	assert.deepEqual(await captureToolResult([{ type: "text", text: "Image shown" }, image], false), [
		{ type: "text", text: "Image shown" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
	]);
});

test("serializes text-only and image-only Anthropic error tool results as text", async () => {
	assert.equal(await captureToolResult([{ type: "text", text: "Script failed" }], true), "Script failed");
	assert.equal(await captureToolResult([image], true), omittedImage);
});
