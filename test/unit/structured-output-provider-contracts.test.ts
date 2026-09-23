// Transport and preparation regression coverage for #3089 / #3090.
import assert from "node:assert/strict";
import { type Model, REQUEST_AUTH_PREPARATION_TIMEOUT_MS } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { InMemorySettingsStorage, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { inferRouterDecision } from "../../packages/coding-agent/src/core/structured-output/index.js";
import type { JsonObject } from "../../packages/coding-agent/src/core/tools/structured-output.js";
import {
	decisionMessage,
	decisionModel,
	decisionRequest,
	jevResponse,
	messageStream,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function sse(events: object[]) {
	return new Response(
		events
			.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
	for (const status of [200, 401, 429, 529]) {
		test(`${api} real serializer makes one HTTP request at status ${status}`, async () => {
			const model: Model<typeof api> = {
				...decisionModel,
				api,
				id: api === "anthropic-messages" ? "claude-fable-5-1" : "chat",
				compat:
					api === "anthropic-messages"
						? {
								supportsForcedToolChoice: false,
								allowedFallbackModels: [
									{ provider: decisionModel.provider, model: "forbidden-fallback", cost: decisionModel.cost },
								],
							}
						: {},
			};
			const transport = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(
				async (input, init) => {
					const request = new Request(input, init);
					assert.equal(
						request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"),
						api === "anthropic-messages" ? "mock-key" : "Bearer mock-key",
					);
					const payload = await request.json();
					assert.equal(payload.model, model.id);
					assert.equal(payload.fallbacks, undefined);
					assert.equal(payload.tools.length, 1);
					assert.equal(payload.tools[0].name ?? payload.tools[0].function.name, "structured_output");
					assert.deepEqual(payload.tool_choice, api === "anthropic-messages" ? { type: "auto" } : "auto");
					if (status !== 200)
						return Response.json({ error: { type: "rate_limit_error", message: "mock failure" } }, { status });
					if (api === "openai-completions")
						return sse([
							{
								id: "response",
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{
													index: 0,
													id: "choice",
													type: "function",
													function: { name: "structured_output", arguments: '{"route":"none"}' },
												},
											],
										},
										finish_reason: null,
									},
								],
							},
							{
								id: "response",
								choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
								usage: { prompt_tokens: 20, completion_tokens: 10 },
							},
						]);
					return sse([
						{
							type: "message_start",
							message: {
								id: "response",
								type: "message",
								role: "assistant",
								model: model.id,
								content: [],
								stop_reason: null,
								usage: { input_tokens: 20, output_tokens: 0 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "choice", name: "structured_output", input: {} },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '{"route":"none"}' },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "tool_use", stop_sequence: null },
							usage: { output_tokens: 10 },
						},
						{ type: "message_stop" },
					]);
				},
			);
			vi.stubGlobal("fetch", transport);
			const runtime = await ModelRuntime.create({
				modelsPath: null,
				credentials: AuthStorage.inMemory(),
				refreshOnCreate: false,
			});
			runtime.registerProvider(model.provider, { api, baseUrl: model.baseUrl, apiKey: "mock-key", models: [model] });
			const pending = inferRouterDecision({
				...decisionRequest(),
				settings: SettingsManager.inMemory({ routerModel: `${model.provider}/${model.id}` }),
				currentModel: model,
				modelRegistry: new ModelRegistry(runtime),
				// Decision-layer transient retries are covered elsewhere; disable them
				// here to isolate the per-attempt serializer contract (#3206).
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			});
			if (status === 200) assert.deepEqual((await pending).value, { route: "none" });
			else await assert.rejects(pending, /inference ended with error/);
			assert.equal(transport.mock.calls.length, 1);
			assert.equal(
				model.compat && "allowedFallbackModels" in model.compat
					? model.compat.allowedFallbackModels?.length
					: undefined,
				api === "anthropic-messages" ? 1 : undefined,
			);
		});
	}
}

for (const invalid of [null, false, 7, [], {}, "auto", " "]) {
	test(`loaded invalid setting ${JSON.stringify(invalid)} rejects before inference`, async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ routerModel: invalid }));
		const settings = SettingsManager.fromStorage(storage);
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const transport = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", transport);
		await assert.rejects(inferRouterDecision({ ...decisionRequest(), settings }), /Invalid routerModel/);
		assert.equal(transport.mock.calls.length, 0);
	});
}

test("global/project settings honor trust, explicit empty override and reload without changing chat defaults", async () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({
			routerModel: "decision-test/chat",
			defaultModel: "saved-chat",
			defaultProvider: "saved-provider",
		}),
	);
	storage.withLock("project", () => JSON.stringify({ routerModel: "typesafe-ai/jev-latest" }));
	const settings = SettingsManager.fromStorage(storage);
	assert.equal(settings.getRouterModel(), "typesafe-ai/jev-latest");
	const untrusted = SettingsManager.fromStorage(storage, { projectTrusted: false });
	assert.equal(untrusted.getRouterModel(), "decision-test/chat");
	untrusted.setProjectTrusted(true);
	assert.equal(untrusted.getRouterModel(), "typesafe-ai/jev-latest");
	storage.withLock("project", () => JSON.stringify({ routerModel: "" }));
	await settings.reload();
	assert.equal(settings.getRouterModel(), "");
	assert.equal(settings.getDefaultModel(), "saved-chat");
	assert.equal(settings.getDefaultProvider(), "saved-provider");
});

const invalidStates: JsonObject[] = [{}, { task: Number.NaN }, { task: Number.POSITIVE_INFINITY }];
for (const state of invalidStates) {
	test(`invalid state ${JSON.stringify(state)} is rejected before any provider request`, async () => {
		const request = decisionRequest();
		const dispatch = vi.fn(() => messageStream(decisionMessage()));
		await assert.rejects(
			inferRouterDecision({
				...request,
				state,
				modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
			}),
			/state|JSON data/,
		);
		assert.equal(dispatch.mock.calls.length, 0);
	});
}

for (const maxTokens of [0, -1, 0.5, Infinity, NaN, 2 ** 31]) {
	test(`invalid output token bound ${maxTokens} is rejected`, async () => {
		await assert.rejects(inferRouterDecision({ ...decisionRequest(), maxTokens }), /maxTokens/);
	});
}

test("explicit Jev without its key fails without a chat model to fall back to (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
		}),
		/requires an API key.*\/login typesafe/,
	);
});

test("Jev network errors do not leak transport messages and honor a disabled retry policy (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => {
		throw new Error("private request body and key");
	});
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
		}),
		/Jev request failed/,
	);
	assert.equal(transport.mock.calls.length, 1);
});

test("Jev input snapshot cannot be changed while awaiting transport", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const late = Promise.withResolvers<Response>();
	vi.stubGlobal("fetch", () => late.promise);
	const request = decisionRequest();
	const questions = {
		...request.jev.questions,
		route: { ...request.jev.questions.route, criteria: { ...request.jev.questions.route.criteria } },
	};
	const pending = inferRouterDecision({
		...request,
		settings: SettingsManager.inMemory(),
		jev: { ...request.jev, questions },
	});
	Reflect.deleteProperty(questions.route.criteria, "review");
	late.resolve(Response.json(jevResponse()));
	assert.equal((await pending).value.route, "review");
});

for (const reason of ["cancel", "oversized"] as const) {
	test(`Jev ${reason} body is cancelled before mapping`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancelled = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				if (reason === "oversized") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
			},
			cancel: cancelled,
		});
		vi.stubGlobal("fetch", async () => new Response(body));
		const request = decisionRequest();
		const decode = vi.fn(request.jev.decode);
		const pending = assert.rejects(
			inferRouterDecision({
				...request,
				currentModel: undefined,
				settings: SettingsManager.inMemory(),
				signal: controller.signal,
				jev: { ...request.jev, decode },
			}),
			reason === "cancel" ? /cancelled/ : /1 MiB/,
		);
		await vi.advanceTimersByTimeAsync(120_000);
		if (reason === "cancel") controller.abort();
		await pending;
		assert.equal(cancelled.mock.calls.length, 1);
		assert.equal(decode.mock.calls.length, 0);
	});
}

for (const reason of ["cancel", "delayed-cancel"] as const) {
	test(`ordinary ${reason} during credential preparation cannot dispatch after late OAuth refresh`, async () => {
		vi.useFakeTimers();
		const lateAuth = Promise.withResolvers<{ access: string; refresh: string; expires: number }>();
		const entered = Promise.withResolvers<void>();
		const dispatch = vi.fn(() => messageStream(decisionMessage()));
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			refreshOnCreate: false,
			credentials: AuthStorage.inMemory({
				[decisionModel.provider]: { type: "oauth", access: "expired", refresh: "mock-refresh", expires: 1 },
			}),
		});
		runtime.registerProvider(decisionModel.provider, {
			api: decisionModel.api,
			baseUrl: decisionModel.baseUrl,
			models: [decisionModel],
			streamSimple: dispatch,
			oauth: {
				name: "Decision test",
				login: async () => ({ access: "mock", refresh: "mock", expires: 1 }),
				refreshToken: () => {
					entered.resolve();
					return lateAuth.promise;
				},
				getApiKey: (credential) => credential.access,
			},
		});
		const controller = new AbortController();
		const pending = inferRouterDecision({
			...decisionRequest(),
			modelRegistry: new ModelRegistry(runtime),
			signal: controller.signal,
		});
		const rejected = assert.rejects(pending, /cancelled/);
		await entered.promise;
		assert.equal(dispatch.mock.calls.length, 0);
		if (reason === "delayed-cancel") await vi.advanceTimersByTimeAsync(REQUEST_AUTH_PREPARATION_TIMEOUT_MS - 1);
		controller.abort();
		await rejected;
		lateAuth.resolve({ access: "late-mock-key", refresh: "mock-refresh", expires: Number.MAX_SAFE_INTEGER });
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(dispatch.mock.calls.length, 0);
	});
}
