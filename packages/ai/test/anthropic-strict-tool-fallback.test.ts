import assert from "node:assert/strict";
import type { BetaTool, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, it, vi } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.js";
import type { Model, Tool } from "../src/types.js";
import { normalizeContext } from "../src/utils/transcript.js";

const grammarError = "The compiled grammar is too large";
const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
	compat: { supportsStrictTools: true },
};
function tool(name: string, strict: "prefer" | "require"): Tool {
	return {
		name,
		description: "Look up a value",
		parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
		constrainedSampling: { type: "json_schema", strict },
	};
}
function errorResponse(message = grammarError, status = 400): Response {
	return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });
}
function successResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
function harness(respond: (attempt: number) => Response) {
	const payloads: MessageCreateParamsStreaming[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		payloads.push(JSON.parse(init?.body as string) as MessageCreateParamsStreaming);
		return respond(payloads.length);
	};
	return { payloads, options: { apiKey: "test-key", fetch, maxRetries: 0 } satisfies AnthropicOptions };
}
const context = (tools: Tool[]) =>
	normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 1 }] });

describe("Anthropic strict tool capacity fallback (#10409)", () => {
	it.each([grammarError, "Too many strict tools (32)", "Schemas contains too many parameters with union types (480)"])(
		"retries %s only for preferred tools",
		async (message) => {
			const transcript = context([tool("preferred", "prefer"), tool("required", "require")]);
			const original = JSON.stringify(transcript);
			const { payloads, options } = harness((attempt) =>
				attempt === 1 ? errorResponse(message) : successResponse(),
			);
			const onPayload = vi.fn((payload: unknown) => ({
				...(payload as MessageCreateParamsStreaming),
				inference_geo: "us",
				stream: false,
			}));
			const onResponse = vi.fn();
			const result = await stream(model, transcript, { ...options, onPayload, onResponse }).result();
			assert.equal(result.stopReason, "stop");
			assert.equal(payloads.length, 2);
			const first = payloads[0].tools as BetaTool[];
			const second = payloads[1].tools as BetaTool[];
			assert.equal(first[0].strict, true);
			assert.equal(second[0].strict, undefined);
			assert.deepEqual(second[0].input_schema, {
				type: "object",
				properties: { value: { type: "string" }, optional: { type: "number" } },
				required: ["value"],
			});
			assert.deepEqual(second[1], first[1]);
			assert.equal(second[1].strict, true);
			assert.deepEqual(
				payloads.map((payload) => payload.stream),
				[true, true],
			);
			assert.equal(payloads[1].inference_geo, "us");
			assert.equal(onPayload.mock.calls.length, 2);
			assert.equal(onResponse.mock.calls.length, 1);
			assert.equal(JSON.stringify(transcript), original);
			assert.equal(result.diagnostics?.[0]?.type, "anthropic_strict_tools_fallback");
		},
	);
	it.each([
		["required tools", [tool("lookup", "require")], grammarError, 400],
		["unrelated rejection", [tool("lookup", "prefer")], "Invalid tool schema", 400],
		["wrong status", [tool("lookup", "prefer")], grammarError, 500],
	] as const)("does not downgrade %s", async (_name, tools, message, status) => {
		const { payloads, options } = harness(() => errorResponse(message, status));
		assert.equal((await stream(model, context([...tools]), options).result()).stopReason, "error");
		assert.equal(payloads.length, 1);
	});
	it("retries at most once", async () => {
		const { payloads, options } = harness(() => errorResponse());
		assert.equal((await stream(model, context([tool("lookup", "prefer")]), options).result()).stopReason, "error");
		assert.equal(payloads.length, 2);
	});
	it("does not retry after stream headers", async () => {
		const { payloads, options } = harness(
			() =>
				new Response(
					`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: grammarError } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		assert.equal((await stream(model, context([tool("lookup", "prefer")]), options).result()).stopReason, "error");
		assert.equal(payloads.length, 1);
	});
	it("honors cancellation before a fallback attempt", async () => {
		const controller = new AbortController();
		const { payloads, options } = harness(() => {
			controller.abort();
			return errorResponse();
		});
		assert.equal(
			(await stream(model, context([tool("lookup", "prefer")]), { ...options, signal: controller.signal }).result())
				.stopReason,
			"aborted",
		);
		assert.equal(payloads.length, 1);
	});
	it("downgrades inline additions but preserves same-name required redefinitions", async () => {
		const transcript = context([tool("lookup", "require")]);
		transcript.messages.push(
			{ role: "system", content: "", toolsAdded: [tool("lookup", "prefer")], timestamp: 2 },
			{ role: "system", content: "", toolsAdded: [tool("lookup", "require")], timestamp: 3 },
		);
		const { payloads, options } = harness((attempt) => (attempt === 1 ? errorResponse() : successResponse()));
		const result = await stream(
			{
				...model,
				compat: { ...model.compat, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
			},
			transcript,
			{ ...options, apiKey: "sk-ant-oat-test" },
		).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(payloads.length, 2);
		assert.deepEqual(payloads[1].tools, payloads[0].tools);
		const additions = payloads.map((payload) =>
			payload.messages.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.flatMap((block) =>
							block.type === "tool_addition" && block.tool.type === "tool_definition"
								? [block.tool.definition as BetaTool]
								: [],
						)
					: [],
			),
		);
		assert.deepEqual(
			additions[0].map((definition) => definition.strict),
			[true, true],
		);
		assert.deepEqual(
			additions[1].map((definition) => definition.strict),
			[undefined, true],
		);
		assert.deepEqual(additions[1][0].input_schema.required, ["value"]);
		assert.deepEqual(additions[1][1], additions[0][1]);
	});

	it("keeps fallback request-local", async () => {
		const { payloads, options } = harness((attempt) => (attempt === 1 ? errorResponse() : successResponse()));
		const transcript = context([tool("lookup", "prefer")]);
		await stream(model, transcript, options).result();
		await stream(model, transcript, options).result();
		assert.deepEqual(
			payloads.map((payload) => (payload.tools as BetaTool[])[0].strict),
			[true, undefined, true],
		);
	});

	it("does not retry a payload hook exception", async () => {
		const { payloads, options } = harness(() => successResponse());
		const result = await stream(model, context([tool("lookup", "prefer")]), {
			...options,
			onPayload: () => {
				throw new Error(grammarError);
			},
		}).result();
		assert.equal(result.stopReason, "error");
		assert.equal(payloads.length, 0);
		assert.equal(result.diagnostics, undefined);
	});
});
