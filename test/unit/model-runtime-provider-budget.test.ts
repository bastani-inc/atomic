import assert from "node:assert/strict";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, Provider } from "@bastani/pi-ai";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import {
	configureProviderRequestBudget,
	providerRateLimitSnapshot,
	recordProviderRateLimit,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { admitProviderStream } from "../../packages/coding-agent/src/core/provider-request-admission.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function runtimeFixture(provider: string, dispatch: () => void) {
	const model: Model<Api> = {
		id: "probe",
		name: "Probe",
		provider,
		api: "google-generative-ai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const stream: Provider["stream"] = (_model, _context, options) => {
		assert.equal(options?.fetch, undefined, "Google must not receive an unsupported custom fetch");
		dispatch();
		const result: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider,
			model: model.id,
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const output = createAssistantMessageEventStream();
		output.push({ type: "done", reason: "stop", message: result });
		return output;
	};
	runtime.registerNativeProvider({
		id: provider,
		name: provider,
		getModels: () => [model],
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" }, source: "stored" }) } },
		stream,
		streamSimple: stream,
	});
	return { runtime, model };
}

test("provider request budgets are shared by separate model runtimes and admit atomically (#3864)", async () => {
	let calls = 0;
	const provider = "shared-budget";
	const first = await runtimeFixture(provider, () => calls++);
	const second = await runtimeFixture(provider, () => calls++);
	configureProviderRequestBudget(provider, { maxRequests: 1, intervalMs: 1000 });
	const a = first.runtime.completeSimple(first.model, { messages: [] });
	const b = second.runtime.completeSimple(second.model, { messages: [] });
	try {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(999);
		assert.equal(calls, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal((await a).stopReason, "stop");
		assert.equal((await b).stopReason, "stop");
		assert.equal(calls, 2);
	} finally {
		configureProviderRequestBudget(provider, undefined);
		await vi.runAllTimersAsync();
		await Promise.allSettled([a, b]);
	}
});

test("HTTP admission gates inner provider retries and records each 429 once (#3864)", async () => {
	const { model: base } = await runtimeFixture("http-budget", () => {});
	const model = { ...base, api: "openai-completions" };
	let calls = 0;
	const fetcher: typeof fetch = Object.assign(async () => {
		calls++;
		return new Response("{}", { status: calls === 1 ? 429 : 200, headers: { "Retry-After": "2" } });
	}, globalThis.fetch);
	const admission = await admitProviderStream(model, { fetch: fetcher }, false);
	await admission.run(() => admission.options.fetch!("https://example.invalid"));
	const failure: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		timestamp: Date.now(),
		errorMessage: "Server requested 2s retry delay",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	admission.observeFailure(failure);
	assert.match(failure.errorMessage!, /429/);
	recordProviderRateLimit(model.provider, new Error(failure.errorMessage, { cause: failure }));
	assert.equal(providerRateLimitSnapshot(model.provider)?.rateLimitCount, 1);
	const retry = admission.run(() => admission.options.fetch!("https://example.invalid"));
	await vi.advanceTimersByTimeAsync(1999);
	assert.equal(calls, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal((await retry).status, 200);
	assert.equal(calls, 2);
});

test.each(["stream", "streamSimple"] as const)(
	"aborting budget admission preserves aborted %s events (#3864)",
	async (method) => {
		let calls = 0;
		const { runtime, model } = await runtimeFixture("abort-budget", () => calls++);
		configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 60_000 });
		try {
			assert.equal((await runtime.completeSimple(model, { messages: [] })).stopReason, "stop");
			const controller = new AbortController();
			const stream = runtime[method](model, { messages: [] }, { signal: controller.signal });
			const events: AssistantMessageEvent[] = [];
			const collected = (async () => {
				for await (const event of stream) events.push(event);
			})();
			const pending = stream.result();
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(calls, 1);
			controller.abort(new Error("cancel queued request"));
			const result = await pending;
			await collected;
			assert.equal(result.errorMessage, "cancel queued request");
			assert.equal(result.stopReason, "aborted");
			const terminal = events.at(-1);
			assert.equal(terminal?.type, "error");
			assert.equal(terminal?.type === "error" && terminal.reason, "aborted");
			assert.equal(calls, 1);
		} finally {
			configureProviderRequestBudget(model.provider, undefined);
		}
	},
);

test("shared transports keep concurrent stream failure observations separate (#3864)", async () => {
	const { model: base } = await runtimeFixture("concurrent-http-observation", () => {});
	const model = { ...base, api: "openai-completions" };
	let calls = 0;
	const fetcher: typeof fetch = Object.assign(async () => {
		calls++;
		return new Response("{}", { status: calls === 1 ? 429 : 200, headers: { "Retry-After": "1" } });
	}, globalThis.fetch);
	const first = await admitProviderStream(model, { fetch: fetcher }, false);
	const second = await admitProviderStream(model, { fetch: fetcher }, false);
	await Promise.all([
		first.run(() => first.options.fetch!("https://example.invalid")),
		second.run(() => second.options.fetch!("https://example.invalid")),
	]);
	const failure: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: "error",
		timestamp: Date.now(),
		errorMessage: "Server requested retry delay",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const unrelated = { ...failure, errorMessage: "unrelated failure" };
	first.observeFailure(failure);
	second.observeFailure(unrelated);
	assert.match(failure.errorMessage!, /429/);
	assert.equal(unrelated.errorMessage, "unrelated failure");
	assert.equal(providerRateLimitSnapshot(model.provider)?.rateLimitCount, 1);
});
