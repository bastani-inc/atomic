import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://test.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

function streamResponse(): Response {
	return new Response(
		'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("provider stream hooks (#6790)", () => {
	afterEach(() => vi.useRealTimers());

	it.each(["onPayload", "onResponse", "onProviderStreamEvent"] as const)(
		"does not wait for an uncooperative %s hook after Esc or its deadline (#6790)",
		async (hook) => {
			vi.useFakeTimers();
			for (const endBy of ["Esc", "deadline"] as const) {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const controller = new AbortController();
				const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => streamResponse());
				const done: AssistantMessage[] = [];
				const result = stream(model, context, {
					apiKey: "test-key",
					maxRetries: 0,
					timeoutMs: 25,
					streamDeadlineMs: 50,
					signal: controller.signal,
					fetch,
					[hook]: () => {
						entered.resolve();
						return release.promise;
					},
				}).result().then((message) => done.push(message));
				try {
					await entered.promise;
					if (endBy === "Esc") {
						controller.abort(new Error("Esc"));
						await vi.advanceTimersByTimeAsync(0);
					} else {
						await vi.advanceTimersByTimeAsync((hook === "onProviderStreamEvent" ? 50 : 25) - 1);
						assert.equal(done.length, 0);
						await vi.advanceTimersByTimeAsync(1);
					}
					assert.equal(done.length, 1, `${hook} outlived ${endBy}`);
					assert.equal(done[0]?.stopReason, endBy === "Esc" ? "aborted" : "error");
					assert.ok(done[0]?.errorMessage?.includes(hook), done[0]?.errorMessage);
				} finally {
					release.resolve();
					await result;
				}
				assert.equal(fetch.mock.calls.length, hook === "onPayload" ? 0 : 1);
			}
		},
	);
});
