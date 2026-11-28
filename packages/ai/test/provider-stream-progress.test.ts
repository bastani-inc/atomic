import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
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
const encoder = new TextEncoder();

function chunk(content: string): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
}

describe("provider stream content progress (#6790)", () => {
	afterEach(() => vi.useRealTimers());

	it.each(["", "x"])("distinguishes a trickle of %j deltas from actual progress (#6790)", async (content) => {
		vi.useFakeTimers();
		const resumed = Promise.withResolvers<void>();
		const final: AssistantMessage[] = [];
		let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
		let closed = false;
		const open = new ReadableStream<Uint8Array>({ start: (controller) => { feed = controller; }, cancel: () => { closed = true; } });
		const result = stream(model, context, {
			apiKey: "test-key",
			maxRetries: 0,
			streamDeadlineMs: 25,
			fetch: async () => new Response(open, { headers: { "content-type": "text/event-stream" } }),
			onResponse: () => resumed.resolve(),
		}).result().then((message) => final.push(message));
		try {
			await resumed.promise;
			for (let i = 0; i < 6 && !closed; i++) {
				await vi.advanceTimersByTimeAsync(10);
				if (!closed) feed?.enqueue(chunk(content));
			}
			if (content) {
				assert.equal(final.length, 0, "a progressing stream was cut");
				feed?.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
				feed?.close();
				closed = true;
				await result;
				assert.equal(final[0]?.stopReason, "stop", final[0]?.errorMessage);
				assert.deepEqual(final[0]?.content, [{ type: "text", text: "xxxxxx" }]);
			} else {
				assert.equal(final.length, 1, "empty deltas let the stream outlive the deadline");
				assert.equal(final[0]?.stopReason, "error");
				assert.match(final[0]?.errorMessage ?? "", /without progress/);
				assert.ok(final[0] && isRetryableAssistantError(final[0]));
			}
		} finally {
			if (!closed) feed?.close();
			await result;
		}
	});
});
