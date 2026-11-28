import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.js";
import { stream as azure } from "../src/api/azure-openai-responses.js";
import { stream as completions } from "../src/api/openai-completions.js";
import { stream as responses } from "../src/api/openai-responses.js";
import type { Api, AssistantMessage, Model, StreamOptions } from "../src/types.js";
import { isRetryableAssistantError } from "../src/utils/retry.js";
import { normalizeContext } from "../src/utils/transcript.js";

const LONG_TIMEOUT_MS = 3_000_000_000;
const VENDOR_BACKSTOP_MS = 2_147_483_647;

const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });
function model<T extends Api>(api: T, provider: string, id: string, baseUrl = "https://fixture.invalid/v1"): Model<T> {
	return { api, provider, id, name: id, baseUrl, reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}

const cases: readonly [string, (options: StreamOptions) => Promise<AssistantMessage>][] = [
	["OpenAI Chat", (options) => completions(model("openai-completions", "openai", "gpt-4.1"), context, options).result()],
	["OpenAI Responses", (options) => responses(model("openai-responses", "openai", "gpt-4.1"), context, options).result()],
	["Azure Responses", (options) => azure(model("azure-openai-responses", "azure-openai-responses", "gpt-4.1", "https://fixture.invalid/openai/v1"), context, options).result()],
	["Anthropic", (options) => anthropic(model("anthropic-messages", "anthropic", "claude-sonnet-4-5"), context, { ...options, apiKey: "sk-ant-api-fixture" }).result()],
];

function stalledWire() {
	const started = Promise.withResolvers<void>();
	return {
		started: started.promise,
		fetch: vi.fn<typeof fetch>((_input, init) => {
			const signal = init?.signal;
			assert.ok(signal, "a stalled wire request must still carry an abort signal");
			started.resolve();
			return new Promise<Response>((_, reject) => {
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}),
	};
}

afterEach(() => vi.useRealTimers());

test("a request timeout does not erase a 503 Retry-After while its error body stalls (#6807)", async () => {
	vi.useFakeTimers();
	const pulling = Promise.withResolvers<void>();
	const body = new ReadableStream<Uint8Array>({ pull() { pulling.resolve(); return new Promise(() => {}); } });
	const pending = completions(model("openai-completions", "openai", "gpt-4.1"), context, {
		apiKey: "fixture",
		timeoutMs: 25,
		streamDeadlineMs: 0,
		maxRetries: 0,
		fetch: async () => new Response(body, { status: 503, headers: { "Retry-After": "0.5" } }),
	}).result();
	await pulling.promise;
	await vi.advanceTimersByTimeAsync(250);
	const result = await pending;
	assert.equal(result.stopReason, "error");
	assert.equal(result.retryAfterMs, 500);
	assert.equal(isRetryableAssistantError(result), true);
});

test.each(cases)("%s does not abort after 1 ms from an overflowing timeout, and remains cancellable (#6807)", async (_name, run) => {
	vi.useFakeTimers();
	const wire = stalledWire();
	const controller = new AbortController();
	let settled: AssistantMessage | undefined;
	const pending = run({ apiKey: "fixture", timeoutMs: LONG_TIMEOUT_MS, streamDeadlineMs: 0, maxRetries: 0, signal: controller.signal, fetch: wire.fetch });
	void pending.then((result) => { settled = result; });
	await wire.started;
	await vi.advanceTimersByTimeAsync(125);
	assert.equal(wire.fetch.mock.calls.length, 1);
	assert.equal(settled, undefined);
	controller.abort();
	assert.equal((await pending).stopReason, "aborted");
});

test.each(cases)("%s reports the vendor backstop as a retryable request timeout (#6807)", async (_name, run) => {
	vi.useFakeTimers();
	const wire = stalledWire();
	let settled: AssistantMessage | undefined;
	const pending = run({ apiKey: "fixture", timeoutMs: LONG_TIMEOUT_MS, streamDeadlineMs: 0, maxRetries: 0, fetch: wire.fetch });
	void pending.then((result) => { settled = result; });
	await wire.started;
	await vi.advanceTimersByTimeAsync(VENDOR_BACKSTOP_MS - 1);
	assert.equal(settled, undefined);
	await vi.advanceTimersByTimeAsync(1);
	assert.notEqual(settled, undefined, "the SDK backstop settled the attempt");
	const result = await pending;
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed?\s+out|timeout/i);
	assert.equal(isRetryableAssistantError(result), true);
});
