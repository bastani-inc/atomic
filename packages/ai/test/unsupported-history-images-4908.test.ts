import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({ succeed: false }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<unknown> {
			if (!bedrockMock.succeed) return Promise.reject(new Error("mock send"));
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "done" } } };
					yield { contentBlockStop: { contentBlockIndex: 0 } };
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: object;

		constructor(input: object) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: { END_TURN: "end_turn", TOOL_USE: "tool_use" },
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { toInlineImage } from "../src/index.ts";
import type { Api, AssistantMessage, Message, Model } from "../src/types.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";

afterEach(() => {
	bedrockMock.succeed = false;
});

const SVG_BASE64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString("base64");
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const SVG_PLACEHOLDER = "[Image omitted: could not be converted to a supported inline image format (image/svg+xml).]";
const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
};

const bedrockModel: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
};

/** A session whose history already holds the SVG an MCP tool returned, followed by the next user turn. */
function historyWithSvg(model: Model<Api>): TranscriptContext {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "diagram", arguments: {} }],
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
	const messages: Message[] = [
		{ role: "user", content: "Draw the diagram", timestamp: 0 },
		assistant,
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "diagram",
			content: [
				{ type: "text", text: "rendered" },
				{ type: "image", data: SVG_BASE64, mimeType: "image/svg+xml" },
				{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 0,
		},
		{
			role: "user",
			content: [
				{ type: "text", text: "Now describe it" },
				{ type: "image", data: SVG_BASE64, mimeType: "image/svg+xml" },
			],
			timestamp: 0,
		},
	];
	return normalizeContext({ messages });
}

interface AnthropicWireBlock {
	type: string;
	text?: string;
	source?: { media_type: string };
	content?: AnthropicWireBlock[];
}

function anthropicReply(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Every image media type in a request body, and the text that took the place of omitted images. */
function anthropicImages(blocks: AnthropicWireBlock[]): { mediaTypes: string[]; texts: string[] } {
	const mediaTypes: string[] = [];
	const texts: string[] = [];
	const visit = (block: AnthropicWireBlock) => {
		if (block.type === "image" && block.source) mediaTypes.push(block.source.media_type);
		if (block.type === "text" && block.text !== undefined) texts.push(block.text);
		block.content?.forEach(visit);
	};
	blocks.forEach(visit);
	return { mediaTypes, texts };
}

test("the next Anthropic request succeeds when history already holds an SVG image (#4908)", async () => {
	const requests: AnthropicWireBlock[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		const body = JSON.parse(init?.body as string) as { messages: Array<{ content: AnthropicWireBlock[] | string }> };
		const blocks = body.messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content));
		requests.push(...blocks);
		// Like the real API: any inline image outside the four accepted media types is a 400.
		const rejected = anthropicImages(blocks).mediaTypes.find((mediaType) => !ACCEPTED_MEDIA_TYPES.has(mediaType));
		if (rejected) {
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: `bad media_type ${rejected}` } },
				{ status: 400 },
			);
		}
		return anthropicReply();
	};

	const context = historyWithSvg(anthropicModel);
	const original = structuredClone(context);
	const result = await streamAnthropic(anthropicModel, context, {
		apiKey: "test-key",
		fetch,
		maxRetries: 0,
		cacheRetention: "none",
	}).result();

	assert.equal(result.stopReason, "stop", result.errorMessage);
	const { mediaTypes, texts } = anthropicImages(requests);
	assert.deepEqual(mediaTypes, ["image/png"]);
	assert.equal(texts.filter((text) => text === SVG_PLACEHOLDER).length, 2);
	// The stored history keeps its blocks: only the request is rewritten.
	assert.deepEqual(context, original);
});

interface BedrockWireBlock {
	text?: string;
	image?: { format: string; source?: { bytes?: Uint8Array } };
	toolResult?: { content: BedrockWireBlock[] };
}

test("the next Bedrock request is built when history already holds an SVG image (#4908)", async () => {
	bedrockMock.succeed = true;
	let payload: { messages: Array<{ content: BedrockWireBlock[] }> } | undefined;

	const result = await streamBedrock(bedrockModel, historyWithSvg(bedrockModel), {
		cacheRetention: "none",
		onPayload: (value) => {
			payload = value as typeof payload;
			return value;
		},
	}).result();

	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.ok(payload);
	const blocks = payload.messages.flatMap((message) =>
		message.content.flatMap((block) => (block.toolResult ? block.toolResult.content : [block])),
	);
	assert.deepEqual(
		blocks.filter((block) => block.image).map((block) => block.image?.format),
		["png"],
	);
	assert.equal(blocks.find((block) => block.image)?.image?.source?.bytes?.length, 70);
	assert.equal(blocks.filter((block) => block.text === SVG_PLACEHOLDER).length, 2);
});

test("Bedrock receives every accepted image format, with its media type normalized (#4908)", async () => {
	bedrockMock.succeed = true;
	let payload: { messages: Array<{ content: BedrockWireBlock[] }> } | undefined;
	const image = (mimeType: string) => ({ type: "image" as const, data: PNG_BASE64, mimeType });

	await streamBedrock(
		bedrockModel,
		normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						image("image/jpeg"),
						image("image/gif"),
						image("image/webp"),
						image("IMAGE/JPG ; q=1"),
						image("image/png"),
					],
					timestamp: 0,
				},
			],
		}),
		{
			cacheRetention: "none",
			onPayload: (value) => {
				payload = value as typeof payload;
				return value;
			},
		},
	).result();

	assert.ok(payload);
	assert.deepEqual(
		payload.messages[0]?.content.map((block) => block.image?.format),
		["jpeg", "gif", "webp", "jpeg", "png"],
	);
});

test("toInlineImage keeps accepted images and replaces any other with a placeholder naming its type (#4908)", () => {
	const png = { type: "image" as const, data: PNG_BASE64, mimeType: "image/png" };
	assert.equal(toInlineImage(png), png);
	assert.deepEqual(toInlineImage({ ...png, mimeType: "Image/WebP" }), { ...png, mimeType: "image/webp" });
	assert.deepEqual(toInlineImage({ ...png, mimeType: "image/bmp" }), {
		type: "text",
		text: "[Image omitted: could not be converted to a supported inline image format (image/bmp).]",
	});
});

test("a Gemini request built from history holding an SVG carries a placeholder instead (#4908)", () => {
	const model: Model<"google-generative-ai"> = {
		id: "gemini-test",
		name: "Gemini Test",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const wire = JSON.stringify(convertGoogleMessages(model, historyWithSvg(model)));

	assert.ok(!wire.includes("image/svg+xml\""), wire);
	assert.ok(!wire.includes(SVG_BASE64), wire);
	assert.equal(wire.split(JSON.stringify(SVG_PLACEHOLDER).slice(1, -1)).length - 1, 2, wire);
	assert.ok(wire.includes(PNG_BASE64), wire);
});
