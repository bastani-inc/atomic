import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";

import type { AssistantMessage, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// A long-running stream crosses chunk boundaries at arbitrary bytes. Every provider must parse the same
// SSE bytes to the same message however they are split: a CRLF split into "\r" | "\n", a multibyte
// character split mid-sequence, or a "data:" prefix split mid-word.

const LINE_ENDINGS = { LF: "\n", CRLF: "\r\n", CR: "\r" } as const;
const MULTIBYTE_TEXT = ["Hé", "llo 👋 ", "wörld"];

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

/** Joins SSE events (each a list of field lines) with the given line ending. */
function sseBody(events: string[][], eol: string): Uint8Array {
	return new TextEncoder().encode(events.map((lines) => lines.map((line) => line + eol).join("") + eol).join(""));
}

/** A fetch whose response body arrives as the given chunks. */
function chunkedFetch(chunks: Uint8Array[]): FetchFunction {
	return async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}

function textOf(message: AssistantMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

type StreamWithFetch = (fetch: FetchFunction) => Promise<AssistantMessage>;

/** Streams the body unsplit and split into two chunks at every byte, expecting the same stop reason and text. */
async function assertChunkingInvariant(
	body: Uint8Array,
	run: StreamWithFetch,
	expected: { stopReason: string; text: string },
): Promise<void> {
	const whole = await run(chunkedFetch([body]));
	assert.deepEqual({ stopReason: whole.stopReason, text: textOf(whole) }, expected, whole.errorMessage);
	for (let split = 1; split < body.length; split++) {
		const message = await run(chunkedFetch([body.subarray(0, split), body.subarray(split)]));
		assert.deepEqual(
			{ stopReason: message.stopReason, text: textOf(message) },
			expected,
			`split at byte ${split}: ${message.errorMessage ?? ""}`,
		);
	}
}

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};

function anthropicEvents(texts: string[]): string[][] {
	const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const event = (name: string, data: object) => [`event: ${name}`, `data: ${JSON.stringify(data)}`];
	return [
		event("message_start", { type: "message_start", message: { id: "msg_1", usage } }),
		event("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		[": keep-alive comment"],
		...texts.map((text) =>
			event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		),
		event("content_block_stop", { type: "content_block_stop", index: 0 }),
		event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }),
		event("message_stop", { type: "message_stop" }),
	];
}

const runAnthropic: StreamWithFetch = (fetch) =>
	streamAnthropic(anthropicModel, context, { apiKey: "test-key", fetch, maxRetries: 0 }).result();

describe("Anthropic SSE chunk boundaries", () => {
	it("keeps an event whole when a CRLF is split across chunks (#4899)", async () => {
		const body = sseBody(anthropicEvents(["Hello"]), "\r\n");
		const text = new TextDecoder().decode(body);
		const split = text.indexOf("\r\n") + 1;
		const message = await runAnthropic(chunkedFetch([body.subarray(0, split), body.subarray(split)]));

		assert.equal(message.errorMessage, undefined);
		assert.equal(message.stopReason, "stop");
		assert.equal(textOf(message), "Hello");
	});

	for (const [name, eol] of Object.entries(LINE_ENDINGS)) {
		it(`parses a ${name} stream identically when split at every byte`, async () => {
			await assertChunkingInvariant(sseBody(anthropicEvents(MULTIBYTE_TEXT), eol), runAnthropic, {
				stopReason: "stop",
				text: MULTIBYTE_TEXT.join(""),
			});
		});
	}
});

const mistralModel = getFixtureModel("mistral", "mistral-medium-latest");

function mistralEvents(texts: string[]): string[][] {
	const chunk = (delta: object, finishReason: string | null) => [
		`data: ${JSON.stringify({ id: "r1", model: mistralModel.id, choices: [{ index: 0, delta, finish_reason: finishReason }] })}`,
	];
	// An empty data field carries nothing; padding around [DONE] is ignored.
	return [["data:"], ...texts.map((content) => chunk({ content }, null)), chunk({}, "stop"), ["data:  [DONE] "]];
}

const runMistral: StreamWithFetch = (fetch) => streamMistral(mistralModel, context, { apiKey: "test", fetch }).result();

describe("Mistral SSE chunk boundaries", () => {
	for (const [name, eol] of Object.entries(LINE_ENDINGS)) {
		it(`parses a ${name} stream identically when split at every byte`, async () => {
			await assertChunkingInvariant(sseBody(mistralEvents(MULTIBYTE_TEXT), eol), runMistral, {
				stopReason: "stop",
				text: MULTIBYTE_TEXT.join(""),
			});
		});
	}
});

const codexModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

function codexToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }));
	return `aaa.${payload.toString("base64")}.bbb`;
}

function codexEvents(texts: string[]): string[][] {
	const text = texts.join("");
	const message = (status: string, content: object[]) => ({
		type: "message",
		id: "msg_1",
		role: "assistant",
		status,
		content,
	});
	const event = (data: object) => [`data: ${JSON.stringify(data)}`];
	return [
		// Whitespace-only data carries nothing.
		["data:   "],
		event({ type: "response.output_item.added", item: message("in_progress", []) }),
		event({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
		...texts.map((delta) => event({ type: "response.output_text.delta", delta })),
		event({ type: "response.output_item.done", item: message("completed", [{ type: "output_text", text }]) }),
		event({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		}),
		["data:  [DONE] "],
	];
}

const runCodex: StreamWithFetch = (fetch) =>
	streamOpenAICodexResponses(codexModel, context, { apiKey: codexToken(), transport: "sse", fetch }).result();

describe("OpenAI Codex SSE chunk boundaries", () => {
	for (const [name, eol] of Object.entries(LINE_ENDINGS)) {
		it(`parses a ${name} stream identically when split at every byte`, async () => {
			await assertChunkingInvariant(sseBody(codexEvents(MULTIBYTE_TEXT), eol), runCodex, {
				stopReason: "stop",
				text: MULTIBYTE_TEXT.join(""),
			});
		});
	}
});

const piMessagesModel: Model<"pi-messages"> = {
	id: "auto",
	name: "Auto",
	api: "pi-messages",
	provider: "custom-gateway",
	baseUrl: "https://gateway.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function piMessagesEvents(texts: string[]): string[][] {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const event = (data: object) => [`data: ${JSON.stringify(data)}`];
	return [
		event({ type: "start" }),
		event({ type: "text_start", contentIndex: 0 }),
		...texts.map((delta) => event({ type: "text_delta", contentIndex: 0, delta })),
		event({ type: "done", reason: "stop", usage }),
		["data:  [DONE] "],
	];
}

const runPiMessages: StreamWithFetch = (fetch) =>
	streamPiMessages(piMessagesModel, context, { apiKey: "test-key", fetch }).result();

describe("pi-messages SSE chunk boundaries", () => {
	for (const [name, eol] of Object.entries(LINE_ENDINGS)) {
		it(`parses a ${name} stream identically when split at every byte`, async () => {
			await assertChunkingInvariant(sseBody(piMessagesEvents(MULTIBYTE_TEXT), eol), runPiMessages, {
				stopReason: "stop",
				text: MULTIBYTE_TEXT.join(""),
			});
		});
	}
});
