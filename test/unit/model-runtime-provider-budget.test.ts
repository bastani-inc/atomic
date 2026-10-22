import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, Provider } from "@bastani/pi-ai";
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
	await admission.options.fetch!("https://example.invalid");
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
	const retry = admission.options.fetch!("https://example.invalid");
	await vi.advanceTimersByTimeAsync(1999);
	assert.equal(calls, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal((await retry).status, 200);
	assert.equal(calls, 2);
});

test("aborting budget admission does not dispatch or consume a request (#3864)", async () => {
	let calls = 0;
	const { runtime, model } = await runtimeFixture("abort-budget", () => calls++);
	configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 60_000 });
	assert.equal((await runtime.completeSimple(model, { messages: [] })).stopReason, "stop");
	const controller = new AbortController();
	const pending = runtime.completeSimple(model, { messages: [] }, { signal: controller.signal });
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(calls, 1);
	controller.abort(new Error("cancel queued request"));
	assert.equal((await pending).errorMessage, "cancel queued request");
	assert.equal(calls, 1);
	configureProviderRequestBudget(model.provider, undefined);
});
