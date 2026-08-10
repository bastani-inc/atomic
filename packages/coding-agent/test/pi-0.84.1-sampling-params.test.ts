import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

function makeModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "sampling-test-model",
		name: "Sampling test model",
		api: "openai-completions",
		provider: "sampling-test-provider",
		baseUrl: "https://sampling.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

function finishReasonFetch(): typeof globalThis.fetch {
	return async () =>
		new Response(
			`data: ${JSON.stringify({
				id: "sampling-test-response",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}

function finishlessFetch(delta: JsonObject): typeof globalThis.fetch {
	return async () =>
		new Response(
			`data: ${JSON.stringify({
				id: "finishless-test-response",
				choices: [{ index: 0, delta, finish_reason: null }],
			})}\n\ndata: [DONE]\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}

async function capturePayload(model: Model<"openai-completions">, options: SimpleStreamOptions): Promise<JsonObject> {
	let payload: JsonObject | undefined;
	const result = await streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
		{
			...options,
			apiKey: "test-key",
			fetch: finishReasonFetch(),
			onPayload: (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) {
					throw new Error("Expected an object provider payload");
				}
				payload = value as JsonObject;
			},
		},
	).result();
	if (result.stopReason !== "stop")
		throw new Error(result.errorMessage ?? `Unexpected stop reason: ${result.stopReason}`);
	if (!payload) throw new Error("Provider payload was not captured");
	return payload;
}

describe("pi 0.84.1 sampling and OpenAI compatibility", () => {
	it("merges model and per-request sampling params into the OpenAI payload", async () => {
		const payload = await capturePayload(
			makeModel({ samplingParams: { top_p: 0.95, top_k: 40, vendor_sampler: "fast" } }),
			{
				temperature: 0,
				samplingParams: { temperature: 1, top_p: 0.5, min_p: 0 },
			},
		);

		expect(payload.temperature).toBe(1);
		expect(payload.top_p).toBe(0.5);
		expect(payload.top_k).toBe(40);
		expect(payload.min_p).toBe(0);
		expect(payload.vendor_sampler).toBe("fast");
	});

	it("sends an opt-in vLLM thinking token budget and leaves answer room", async () => {
		const payload = await capturePayload(
			makeModel({
				reasoning: true,
				compat: { supportsThinkingTokenBudget: true },
			}),
			{
				reasoning: "medium",
				thinkingBudgets: { medium: 4096 },
			},
		);

		expect(payload.thinking_token_budget).toBe(4096);
	});

	it("does not send thinking_token_budget without the opt-in compat flag", async () => {
		const payload = await capturePayload(makeModel({ reasoning: true }), {
			reasoning: "medium",
			thinkingBudgets: { medium: 4096 },
		});

		expect(payload.thinking_token_budget).toBeUndefined();
	});

	it.each([true, false])(
		"handles a stream without finish_reason when supportsFinishReason is %s",
		async (supportsFinishReason) => {
			const model = makeModel({ compat: { supportsFinishReason } });
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
				{ apiKey: "test-key", fetch: finishlessFetch({ role: "assistant", content: "complete" }) },
			).result();

			if (supportsFinishReason) {
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe("Stream ended without finish_reason");
			} else {
				expect(result.stopReason).toBe("stop");
				expect(result.errorMessage).toBeUndefined();
				expect(result.content).toEqual([{ type: "text", text: "complete" }]);
			}
		},
	);

	it("infers toolUse when a finishless stream contains a tool call", async () => {
		const result = await streamSimple(
			makeModel({ compat: { supportsFinishReason: false } }),
			{
				messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
				tools: [
					{
						name: "lookup",
						description: "Look something up",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: finishlessFetch({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call-1",
							type: "function",
							function: { name: "lookup", arguments: '{"value":"x"}' },
						},
					],
				}),
			},
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([{ type: "toolCall", id: "call-1", name: "lookup", arguments: { value: "x" } }]);
	});
});
