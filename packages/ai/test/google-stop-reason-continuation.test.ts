import assert from "node:assert/strict";
import { FinishReason } from "@google/genai";
import { describe, it, vi } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { mapStopReason } from "../src/api/google-shared.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("Google CONTINUATION finish reason", () => {
	it("maps CONTINUATION to length, like MAX_TOKENS (#12097)", () => {
		assert.equal(mapStopReason(FinishReason.CONTINUATION), "length");
	});

	it("ends the turn as length instead of letting the SDK send a continuation request (#12097)", async () => {
		const fetch = vi.fn<FetchFunction>(async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			const chunk = bodyText.includes("token-1")
				? {
						candidates: [
							{
								content: { role: "model", parts: [{ text: " resumed" }] },
								finishReason: "STOP",
							},
						],
					}
				: {
						candidates: [
							{
								content: { role: "model", parts: [{ text: "partial" }] },
								finishReason: "CONTINUATION",
								continuationToken: "token-1",
							},
						],
					};
			return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});

		const google = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch,
		}).result();
		const vertex = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch,
		}).result();

		assert.equal(fetch.mock.calls.length, 2);
		assert.equal(google.stopReason, "length");
		assert.equal(vertex.stopReason, "length");
	});
});
