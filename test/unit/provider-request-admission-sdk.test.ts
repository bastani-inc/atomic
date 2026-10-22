import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Model,
	normalizeContext,
	type Provider,
	type StreamOptions,
} from "@bastani/pi-ai";
import { stream as streamAnthropic } from "@bastani/pi-ai/api/anthropic-messages";
import { stream as streamMistral } from "@bastani/pi-ai/api/mistral-conversations";
import { stream as streamCodex } from "@bastani/pi-ai/api/openai-codex-responses";
import { stream as streamOpenAI } from "@bastani/pi-ai/api/openai-completions";
import { createFetchWithAdmission, getFetchAdmission } from "@bastani/pi-ai/utils/request-admission";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { wrapCodexFastRouteFetch } from "../../packages/coding-agent/src/core/fast-model-routing-transport.js";
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

const codexToken = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
).toString("base64")}.bbb`;

function mistralResponse(): Response {
	const event = {
		id: "mistral-response",
		model: "test-model",
		choices: [{ index: 0, finish_reason: "stop", delta: { content: "ok" } }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function codexResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

const headerTimeoutTransports = [
	{
		name: "mistral-conversations",
		model: { ...model, api: "mistral-conversations" } satisfies Model<"mistral-conversations">,
		apiKey: "test-key",
		options: {},
		response: mistralResponse,
		timeout: /Mistral response headers timed out after 20ms/,
		run: (options: StreamOptions) =>
			streamMistral({ ...model, api: "mistral-conversations" }, context, options).result(),
	},
	{
		name: "openai-codex-responses (explicit SSE)",
		model: {
			...model,
			api: "openai-codex-responses",
			provider: "openai-codex-admission",
			baseUrl: "https://example.invalid/backend-api",
		} satisfies Model<"openai-codex-responses">,
		apiKey: codexToken,
		options: { transport: "sse" },
		response: codexResponse,
		timeout: /Codex SSE response headers timed out after 20ms/,
		run: (options: StreamOptions) =>
			streamCodex(
				{
					...model,
					api: "openai-codex-responses",
					provider: "openai-codex-admission",
					baseUrl: "https://example.invalid/backend-api",
				},
				context,
				options,
			).result(),
	},
] as const;

describe.each(headerTimeoutTransports)("$name header timeout admission (#3864)", (transport) => {
	const requestModel: Model<Api> = transport.model;
	const intervalMs = 150;
	const timeoutMs = 20;
	const run = (options: StreamOptions): Promise<AssistantMessage> => transport.run(options);

	beforeEach(() => vi.useRealTimers());
	afterEach(() => configureProviderRequestBudget(requestModel.provider, undefined));

	function queueBehindExhaustedBudget(): void {
		configureProviderRequestBudget(requestModel.provider, { maxRequests: 1, intervalMs });
		assert.equal(tryAdmitProviderRequest(requestModel.provider), 0);
	}

	function hangingFetch(onDispatch: () => void): typeof fetch {
		return Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			onDispatch();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		}, globalThis.fetch);
	}

	test("header timeout starts after admission rather than while queued", async () => {
		queueBehindExhaustedBudget();
		const start = Date.now();
		let dispatchedAfterMs: number | undefined;
		const fetcher: typeof fetch = Object.assign(async () => {
			dispatchedAfterMs = Date.now() - start;
			return transport.response();
		}, globalThis.fetch);
		const admission = await admitProviderStream(
			requestModel,
			{ ...transport.options, apiKey: transport.apiKey, fetch: fetcher, timeoutMs, maxRetries: 0 },
			false,
		);
		const message = await run(admission.options);
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.ok(dispatchedAfterMs !== undefined && dispatchedAfterMs > timeoutMs * 2);
	});

	test.each([
		[
			"cancellation",
			() => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), timeoutMs * 2);
				return controller.signal;
			},
		],
		["a caller deadline", () => AbortSignal.timeout(timeoutMs * 2)],
	])("%s is honored while queued", async (_name, createSignal) => {
		queueBehindExhaustedBudget();
		let dispatches = 0;
		const admission = await admitProviderStream(
			requestModel,
			{
				...transport.options,
				apiKey: transport.apiKey,
				fetch: hangingFetch(() => dispatches++),
				signal: createSignal(),
				timeoutMs,
				maxRetries: 0,
			},
			false,
		);
		assert.equal((await run(admission.options)).stopReason, "aborted");
		assert.equal(dispatches, 0);
	});

	test("header timeout still applies once the request is dispatched", async () => {
		queueBehindExhaustedBudget();
		const start = Date.now();
		let dispatchedAfterMs: number | undefined;
		const admission = await admitProviderStream(
			requestModel,
			{
				...transport.options,
				apiKey: transport.apiKey,
				fetch: hangingFetch(() => {
					dispatchedAfterMs = Date.now() - start;
				}),
				timeoutMs,
				maxRetries: 0,
			},
			false,
		);
		const message = await run(admission.options);
		assert.match(message.errorMessage ?? "", transport.timeout);
		assert.ok(dispatchedAfterMs !== undefined && dispatchedAfterMs > timeoutMs * 2);
	});
});

describe("runtime Codex SSE routing keeps admission ahead of the header timeout (#3864)", () => {
	const intervalMs = 200;
	const timeoutMs = 20;
	const codexFastModel: Model<"openai-codex-responses"> = {
		...model,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		id: "gpt-5.6-sol-fast",
		fastRoute: { baseModelId: "gpt-5.6-sol", upstreamModelId: "gpt-5.6-sol", serviceTier: "priority" },
	};

	beforeEach(() => vi.useRealTimers());
	afterEach(() => configureProviderRequestBudget(codexFastModel.provider, undefined));

	async function createRuntime(): Promise<ModelRuntime> {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const stream: Provider["stream"] = (_model, requestContext, options: StreamOptions | undefined) =>
			streamCodex(codexFastModel, requestContext, options ?? {});
		runtime.registerNativeProvider({
			id: codexFastModel.provider,
			name: "Codex",
			getModels: () => [codexFastModel],
			auth: {
				apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: codexToken }, source: "stored" }) },
			},
			stream,
			streamSimple: stream,
		});
		return runtime;
	}

	function exhaustBudget(): void {
		configureProviderRequestBudget(codexFastModel.provider, { maxRequests: 1, intervalMs });
		assert.equal(tryAdmitProviderRequest(codexFastModel.provider), 0);
	}

	test("dispatches once after the queue wait with routing applied", async () => {
		exhaustBudget();
		const start = Date.now();
		const dispatches: { afterMs: number; headers: Headers }[] = [];
		const fetcher: typeof fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			dispatches.push({ afterMs: Date.now() - start, headers: new Headers(init?.headers) });
			return codexResponse();
		}, globalThis.fetch);
		const runtime = await createRuntime();
		const message = await runtime.completeSimple(codexFastModel, context, {
			fetch: fetcher,
			transport: "sse",
			timeoutMs,
			maxRetries: 0,
		});
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal(dispatches.length, 1);
		assert.ok(dispatches[0]!.afterMs >= intervalMs - timeoutMs);
		assert.equal(dispatches[0]!.headers.get("originator"), "codex_cli_rs");
		assert.equal(dispatches[0]!.headers.get("x-codex-routing-hint"), "model=gpt-5.6-sol;tier=priority");
		assert.equal(dispatches[0]!.headers.get("x-atomic-codex-fast-route"), null);
	});

	test.each([
		[
			"cancellation",
			() => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), timeoutMs * 2);
				return controller.signal;
			},
		],
		["a caller deadline", () => AbortSignal.timeout(timeoutMs * 2)],
	])("%s is honored while queued", async (_name, createSignal) => {
		exhaustBudget();
		let dispatches = 0;
		const fetcher: typeof fetch = Object.assign(async () => {
			dispatches++;
			return codexResponse();
		}, globalThis.fetch);
		const runtime = await createRuntime();
		const message = await runtime.completeSimple(codexFastModel, context, {
			fetch: fetcher,
			signal: createSignal(),
			transport: "sse",
			timeoutMs,
			maxRetries: 0,
		});
		assert.equal(message.stopReason, "aborted");
		assert.equal(dispatches, 0);
	});
});

test("Codex routing wraps an admitted fetch without admitting twice (#3864)", async () => {
	let admissions = 0;
	const seen: Headers[] = [];
	const base: typeof fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push(new Headers(init?.headers));
		return new Response("ok");
	}, globalThis.fetch);
	const admitted = createFetchWithAdmission(base, async () => {
		admissions++;
	});
	const routed = wrapCodexFastRouteFetch(admitted);
	const admission = getFetchAdmission(routed);
	assert.ok(admission);
	await routed("https://chatgpt.com/backend-api/codex/responses", {
		headers: { "x-atomic-codex-fast-route": "normal" },
	});
	assert.equal(admissions, 1);
	assert.equal(seen[0]!.get("x-atomic-codex-fast-route"), null);
	assert.equal(getFetchAdmission(admitted)?.fetch, base);
	await admission.fetch("https://chatgpt.com/backend-api/codex/responses", {
		headers: { "x-atomic-codex-fast-route": "normal" },
	});
	assert.equal(admissions, 1);
	assert.equal(seen[1]!.get("x-atomic-codex-fast-route"), null);
});
