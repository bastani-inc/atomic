import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Model, normalizeContext, type Provider } from "@bastani/pi-ai";
import { stream as streamAnthropic } from "@bastani/pi-ai/api/anthropic-messages";
import { stream as streamOpenAI } from "@bastani/pi-ai/api/openai-completions";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import {
	configureProviderRequestBudget,
	tryAdmitProviderRequest,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { admitProviderStream } from "../../packages/coding-agent/src/core/provider-request-admission.js";

const model = {
	id: "test-model",
	name: "Test",
	provider: "sdk-admission",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} satisfies Model<"openai-completions">;
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	configureProviderRequestBudget(model.provider, undefined);
	vi.useRealTimers();
});

test("SDK HTTP timeout starts after admission rather than while queued (#3864)", async () => {
	configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 1000 });
	assert.equal(tryAdmitProviderRequest(model.provider), 0);
	let dispatches = 0;
	const fetcher: typeof fetch = Object.assign(async () => {
		dispatches++;
		return new Response(
			'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{
				headers: { "content-type": "text/event-stream" },
			},
		);
	}, globalThis.fetch);
	const admission = await admitProviderStream(
		model,
		{ apiKey: "test-key", fetch: fetcher, timeoutMs: 20, maxRetries: 0 },
		false,
	);
	const result = streamOpenAI(model, context, admission.options).result();
	await vi.advanceTimersByTimeAsync(999);
	assert.equal(dispatches, 0);
	await vi.advanceTimersByTimeAsync(1);
	const message = await result;
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.equal(dispatches, 1);
});

function anthropicResponse(): Response {
	return new Response(
		[
			'event: message_start\ndata: {"type":"message_start","message":{"id":"test","usage":{"input_tokens":1,"output_tokens":0}}}\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n',
		].join("\n"),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

test("Anthropic HTTP timeout starts after admission rather than while queued (#3864)", async () => {
	const anthropicModel: Model<"anthropic-messages"> = { ...model, api: "anthropic-messages" };
	configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 1000 });
	assert.equal(tryAdmitProviderRequest(model.provider), 0);
	let dispatches = 0;
	const fetcher: typeof fetch = Object.assign(async () => {
		dispatches++;
		return anthropicResponse();
	}, globalThis.fetch);
	const admission = await admitProviderStream(
		anthropicModel,
		{ apiKey: "test-key", fetch: fetcher, timeoutMs: 20, maxRetries: 0 },
		false,
	);
	const result = streamAnthropic(anthropicModel, context, admission.options).result();
	await vi.advanceTimersByTimeAsync(999);
	assert.equal(dispatches, 0);
	await vi.advanceTimersByTimeAsync(1);
	const message = await result;
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.equal(dispatches, 1);
});

test.each([false, true])(
	"runtime admission reuses the Anthropic federation token with budget=%s (#3864)",
	async (budgeted) => {
		const directory = mkdtempSync(join(tmpdir(), "admission-federation-"));
		try {
			const tokenPath = join(directory, "identity.jwt");
			writeFileSync(tokenPath, "header.payload.signature");
			const anthropicModel: Model<"anthropic-messages"> = {
				...model,
				baseUrl: "https://example.invalid",
				provider: "anthropic",
				api: "anthropic-messages",
			};
			const env = {
				ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
				ANTHROPIC_ORGANIZATION_ID: "org-test",
				ANTHROPIC_IDENTITY_TOKEN_FILE: tokenPath,
			};
			const requests: string[] = [];
			const dispatchTimes: number[] = [];
			if (budgeted) configureProviderRequestBudget("anthropic", { maxRequests: 1, intervalMs: 1000 });
			const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				requests.push(path);
				dispatchTimes.push(Date.now());
				if (path === "/v1/oauth/token") return Response.json({ access_token: "federated-token", expires_in: 3600 });
				assert.equal(request.headers.get("authorization"), "Bearer federated-token");
				return anthropicResponse();
			}, globalThis.fetch);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const stream: Provider["stream"] = (_model, context, options) =>
				streamAnthropic(anthropicModel, context, {
					fetch: options?.fetch,
					env: options?.env,
					signal: options?.signal,
				});
			runtime.registerNativeProvider({
				id: "anthropic",
				name: "Anthropic",
				getModels: () => [anthropicModel],
				auth: { apiKey: { name: "federation", resolve: async () => ({ auth: {}, env }) } },
				stream,
				streamSimple: stream,
			});
			for (let i = 0; i < 3; i++) {
				const pending = runtime.completeSimple(anthropicModel, { messages: [] }, { fetch: fetcher });
				let completed = false;
				void pending.then(() => {
					completed = true;
				});
				await vi.waitFor(() => assert.ok(completed), { timeout: 10_000, interval: 1000 });
				const result = await pending;
				assert.equal(result.stopReason, "stop", result.errorMessage);
			}
			assert.deepEqual(requests, ["/v1/oauth/token", "/v1/messages", "/v1/messages", "/v1/messages"]);
			if (budgeted) {
				for (let i = 1; i < dispatchTimes.length; i++) assert.ok(dispatchTimes[i]! - dispatchTimes[i - 1]! >= 1000);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
			configureProviderRequestBudget("anthropic", undefined);
		}
	},
);

test.each(["openai-completions", "anthropic-messages"] as const)(
	"%s retains cancellation and transport timeouts after admission (#3864)",
	async (api) => {
		const requestModel = { ...model, api };
		configureProviderRequestBudget(model.provider, { maxRequests: 1, intervalMs: 1000 });
		assert.equal(tryAdmitProviderRequest(model.provider), 0);
		let dispatches = 0;
		const fetcher: typeof fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			dispatches++;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		}, globalThis.fetch);
		const controller = new AbortController();
		const start = async (signal?: AbortSignal) => {
			const admission = await admitProviderStream(
				requestModel,
				{ apiKey: "test-key", fetch: fetcher, signal, timeoutMs: 20, maxRetries: 0 },
				false,
			);
			return admission.run(() =>
				api === "openai-completions"
					? streamOpenAI({ ...requestModel, api }, context, admission.options).result()
					: streamAnthropic({ ...requestModel, api }, context, admission.options).result(),
			);
		};
		const cancelled = start(controller.signal);
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		assert.equal((await cancelled).stopReason, "aborted");
		assert.equal(dispatches, 0);
		const timedOut = start();
		await vi.advanceTimersByTimeAsync(899);
		assert.equal(dispatches, 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(dispatches, 1);
		await vi.advanceTimersByTimeAsync(20);
		assert.match((await timedOut).errorMessage!, /timed out/i);
	},
);

test("cancelling an Anthropic stream does not wait for or cancel its shared federation exchange (#3864)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "cancel-federation-"));
	const tokenPath = join(directory, "identity.jwt");
	writeFileSync(tokenPath, "header.payload.signature");
	const anthropicModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "https://example.invalid",
		provider: "anthropic",
		api: "anthropic-messages",
	};
	const env = {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_cancel",
		ANTHROPIC_ORGANIZATION_ID: "org-test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: tokenPath,
	};
	let releaseExchange = () => {};
	let exchangeStarted = () => {};
	const started = new Promise<void>((resolve) => {
		exchangeStarted = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		releaseExchange = resolve;
	});
	let tokenCalls = 0;
	const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
		if (new URL(String(input)).pathname === "/v1/oauth/token") {
			tokenCalls++;
			exchangeStarted();
			await blocked;
			return Response.json({ access_token: "shared-token", expires_in: 3600 });
		}
		return anthropicResponse();
	}, globalThis.fetch);
	const controller = new AbortController();
	const first = await admitProviderStream(anthropicModel, { fetch: fetcher, env, signal: controller.signal }, false);
	const second = await admitProviderStream(anthropicModel, { fetch: fetcher, env }, false);
	let cancelled: AssistantMessage | undefined;
	const leader = first.run(() => streamAnthropic(anthropicModel, context, first.options).result());
	void leader.then((result) => {
		cancelled = result;
	});
	await started;
	const follower = second.run(() => streamAnthropic(anthropicModel, context, second.options).result());
	try {
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(cancelled?.stopReason, "aborted");
		releaseExchange();
		assert.equal((await follower).stopReason, "stop");
		assert.equal(tokenCalls, 1);
	} finally {
		releaseExchange();
		await Promise.all([leader, follower]);
		rmSync(directory, { recursive: true, force: true });
	}
});
