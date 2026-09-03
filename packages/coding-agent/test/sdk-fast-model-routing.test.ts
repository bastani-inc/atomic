import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ModelFastRoute,
	type SimpleStreamOptions,
} from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CODEX_FAST_ROUTE_HEADER, CODEX_FAST_ROUTE_ORIGINATOR } from "../src/core/fast-model-routing-transport.ts";
import { FAST_MODEL_SERVICE_TIER } from "../src/core/fast-model-variants.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedFastRouteRequest {
	model: Model<Api>;
	options: SimpleStreamOptions | undefined;
	payload: unknown;
}

function createModel(provider: string, api: Api): Model<Api> {
	return {
		id: `${provider}-test-model`,
		name: `${provider} Test Model`,
		api,
		provider,
		baseUrl: `https://${provider}.example/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function bodyToText(body: BodyInit | null | undefined): Promise<string> {
	if (body === null || body === undefined) return "";
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Blob) return body.text();
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return new Response(body).text();
}

function copilotResponse(api: Api, modelId: string): Response {
	const headers = { "content-type": "text/event-stream" };
	if (api === "anthropic-messages") {
		return new Response(
			`${[
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: { id: "msg_test", model: modelId, usage: { input_tokens: 1, output_tokens: 0 } },
				})}`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				})}`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
			].join("\n\n")}\n\n`,
			{ status: 200, headers },
		);
	}
	if (api === "openai-completions") {
		return new Response(
			`${[
				`data: ${JSON.stringify({
					id: "chatcmpl_test",
					object: "chat.completion.chunk",
					created: 1,
					model: modelId,
					choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
				})}`,
				`data: ${JSON.stringify({
					id: "chatcmpl_test",
					object: "chat.completion.chunk",
					created: 1,
					model: modelId,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}`,
				"data: [DONE]",
			].join("\n\n")}\n\n`,
			{ status: 200, headers },
		);
	}
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}\n\n`,
		{ status: 200, headers },
	);
}

interface CopilotTurnCapture {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	message: AssistantMessage;
}

function withoutRequestIdentity(headers: Record<string, string>): Record<string, string> {
	const stableHeaders = { ...headers };
	delete stableHeaders.session_id;
	delete stableHeaders["x-client-request-id"];
	return stableHeaders;
}

function createDoneStream(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.end(message);
	return stream;
}

function serviceTierRoute(baseModelId: string): ModelFastRoute {
	return { baseModelId, upstreamModelId: baseModelId, serviceTier: FAST_MODEL_SERVICE_TIER };
}

function advertisedFastRoute(baseModelId: string): ModelFastRoute {
	return { baseModelId, upstreamModelId: `${baseModelId}-fast` };
}

describe("createAgentSession fast model routing", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let registeredProviders: Array<{ registry: ModelRuntime; provider: string }>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-sdk-fast-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		registeredProviders = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const entry of registeredProviders.reverse()) {
			entry.registry.unregisterProvider(entry.provider);
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function captureFastRouteRequest(options: {
		provider: string;
		api?: Api;
		/** Explicit route metadata on the selected model; omitted for a normal model. */
		fastRoute?: ModelFastRoute;
		/** Selected model ID; defaults to the provider's normal test model. */
		modelId?: string;
		payload?: Record<string, unknown>;
		fastModelIds?: string[];
		useBuiltInDispatch?: boolean;
	}): Promise<CapturedFastRouteRequest> {
		const api = options.api ?? ("openai-responses" as Api);
		const baseModel = createModel(options.provider, api);
		const model: Model<Api> = {
			...baseModel,
			...(options.modelId ? { id: options.modelId } : {}),
			...(options.fastRoute ? { fastRoute: options.fastRoute } : {}),
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(options.provider, async () =>
			options.fastModelIds
				? {
						type: "oauth",
						access: "test-access-token",
						refresh: "test-refresh-token",
						expires: Number.MAX_SAFE_INTEGER,
						fastModelIds: options.fastModelIds,
					}
				: { type: "api_key", key: "test-api-key" },
		);
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({});
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedOptions: SimpleStreamOptions | undefined;
		let capturedModel: Model<Api> | undefined;

		const captureProviderStream = (streamModel: Model<Api>, streamOptions: SimpleStreamOptions | undefined) => {
			capturedModel = streamModel;
			capturedOptions = streamOptions;
			return createDoneStream(streamModel);
		};
		const builtInStreamSpy = options.useBuiltInDispatch
			? vi
					.spyOn(modelRuntime, "streamSimple")
					.mockImplementation((streamModel, _context, streamOptions) =>
						captureProviderStream(streamModel, streamOptions),
					)
			: undefined;
		if (!options.useBuiltInDispatch) {
			modelRuntime.registerProvider(options.provider, {
				api,
				streamSimple: (streamModel, _context, streamOptions) => captureProviderStream(streamModel, streamOptions),
			});
			registeredProviders.push({ registry: modelRuntime, provider: options.provider });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, { sessionId: session.sessionId });
			if (options.useBuiltInDispatch && !capturedModel) {
				throw new Error("Expected modelRuntime.streamSimple to receive the request");
			}
			await stream.result();
			if (!capturedModel) throw new Error("Expected the provider stream to receive a model");
			const payload = await session.agent.onPayload?.(options.payload ?? { model: model.id }, model);
			return { model: capturedModel, options: capturedOptions, payload };
		} finally {
			session.dispose();
			builtInStreamSpy?.mockRestore();
			if (!options.useBuiltInDispatch) {
				modelRuntime.unregisterProvider(options.provider);
				registeredProviders = registeredProviders.filter(
					(entry) => entry.registry !== modelRuntime || entry.provider !== options.provider,
				);
			}
		}
	}

	async function captureRealCopilotTurn(
		api: "anthropic-messages" | "openai-responses" | "openai-completions",
		fast: boolean,
		baseModelId = "github-copilot-test-model",
	): Promise<CopilotTurnCapture> {
		const base = { ...createModel("github-copilot", api), id: baseModelId };
		const model: Model<Api> = fast
			? { ...base, id: `${baseModelId}-fast`, fastRoute: advertisedFastRoute(baseModelId) }
			: base;
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("github-copilot", async () => ({
			type: "oauth",
			access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "test-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: [baseModelId],
			fastModelIds: [`${baseModelId}-fast`],
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		let body: Record<string, unknown> | undefined;
		let headers: Record<string, string> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				body = JSON.parse(await bodyToText(init?.body)) as Record<string, unknown>;
				headers = Object.fromEntries(new Headers(init?.headers).entries());
				return copilotResponse(api, model.id);
			}),
		);

		try {
			await session.prompt("hello");
			if (!body || !headers) throw new Error("Expected Copilot fetch to capture a request");
			const message = sessionManager
				.buildSessionContext()
				.messages.findLast((candidate): candidate is AssistantMessage => candidate.role === "assistant");
			if (!message) throw new Error("Expected the Copilot turn to persist an assistant message");
			return { body, headers, message };
		} finally {
			session.dispose();
		}
	}

	// One case per API path: each turn creates a real agent session, so a single test covering all
	// three ran six sessions and exceeded the shared per-test budget on a loaded machine.
	it.each(["anthropic-messages", "openai-responses", "openai-completions"] as const)(
		"sends the advertised Copilot fast ID over %s without headers or service-tier fields",
		async (api) => {
			const fast = await captureRealCopilotTurn(api, true);
			const normal = await captureRealCopilotTurn(api, false);

			assert.equal(fast.body.model, "github-copilot-test-model-fast");
			assert.equal(normal.body.model, "github-copilot-test-model");
			assert.equal("service_tier" in fast.body, false);
			assert.equal("speed" in fast.body, false);
			assert.deepEqual(withoutRequestIdentity(fast.headers), withoutRequestIdentity(normal.headers));
			// The canonical `-fast` identity is what Atomic records, not the base.
			assert.equal(fast.message.model, "github-copilot-test-model-fast");
			assert.equal(normal.message.model, "github-copilot-test-model");
		},
	);

	it("records the selected canonical fast identity on the assistant message", async () => {
		const captured = await captureRealCopilotTurn("openai-responses", true, "gpt-5.6-sol");

		assert.equal(captured.message.provider, "github-copilot");
		assert.equal(captured.message.model, "gpt-5.6-sol-fast");
	});

	it("persists and restores an exact Copilot -fast model ID across sessions", async () => {
		const baseModelId = "gpt-5.6-sol";
		const fastModelId = `${baseModelId}-fast`;
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("github-copilot", async () => ({
			type: "oauth",
			access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "test-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: [baseModelId],
			fastModelIds: [fastModelId],
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		// The derived fast variant is a real selectable model resolvable by its canonical ID.
		const model = modelRuntime.getModel("github-copilot", fastModelId);
		assert.ok(model);
		assert.equal(model.id, fastModelId);
		assert.deepEqual(model.fastRoute, { baseModelId, upstreamModelId: fastModelId });
		const sessionManager = SessionManager.inMemory(cwd);
		const requestBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				requestBodies.push(JSON.parse(await bodyToText(init?.body)) as Record<string, unknown>);
				return copilotResponse("openai-responses", fastModelId);
			}),
		);
		const first = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		await first.session.prompt("first turn");
		first.session.dispose();

		const persisted = sessionManager.buildSessionContext();
		assert.deepEqual(persisted.model, { provider: "github-copilot", modelId: fastModelId });
		const persistedAssistant = persisted.messages.findLast((message) => message.role === "assistant");
		assert.equal(persistedAssistant?.role === "assistant" ? persistedAssistant.model : undefined, fastModelId);

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		try {
			assert.equal(resumed.session.model?.id, fastModelId);
			assert.deepEqual(resumed.session.model?.fastRoute, { baseModelId, upstreamModelId: fastModelId });
			await resumed.session.prompt("second turn");
			assert.deepEqual(
				requestBodies.map((body) => body.model),
				[fastModelId, fastModelId],
			);
		} finally {
			resumed.session.dispose();
		}
	});

	it("keeps entitled Copilot fast requests on the built-in model runtime dispatch path", async () => {
		const captured = await captureFastRouteRequest({
			provider: "github-copilot",
			api: "anthropic-messages",
			modelId: "github-copilot-test-model-fast",
			fastRoute: advertisedFastRoute("github-copilot-test-model"),
			fastModelIds: ["github-copilot-test-model-fast"],
			payload: { model: "github-copilot-test-model-fast", messages: [] },
			useBuiltInDispatch: true,
		});

		assert.equal(captured.model.id, "github-copilot-test-model-fast");
		assert.equal("serviceTier" in (captured.options ?? {}), false);
		assert.equal(captured.options?.headers, undefined);
		assert.deepEqual(captured.payload, { model: "github-copilot-test-model-fast", messages: [] });
		assert.equal("service_tier" in (captured.payload as Record<string, unknown>), false);
		assert.equal("speed" in (captured.payload as Record<string, unknown>), false);
	});

	it("leaves a normal Copilot request untouched", async () => {
		const payload = { model: "github-copilot-test-model", messages: [] };
		const captured = await captureFastRouteRequest({
			provider: "github-copilot",
			api: "anthropic-messages",
			fastModelIds: ["github-copilot-test-model-fast"],
			payload,
		});

		assert.equal(captured.model.id, "github-copilot-test-model");
		assert.strictEqual(captured.payload, payload);
	});

	it("does not treat a bare -fast model ID without route metadata as fast", async () => {
		const captured = await captureFastRouteRequest({
			provider: "openai",
			modelId: "openai-test-model-fast",
		});

		assert.equal(captured.model.id, "openai-test-model-fast");
		expect((captured.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBeUndefined();
		expect(captured.payload).not.toMatchObject({ service_tier: FAST_MODEL_SERVICE_TIER });
	});

	it("adds the priority service tier for an OpenAI service-tier route", async () => {
		const captured = await captureFastRouteRequest({
			provider: "openai",
			modelId: "openai-test-model-fast",
			fastRoute: serviceTierRoute("openai-test-model"),
		});

		expect((captured.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
			FAST_MODEL_SERVICE_TIER,
		);
		// Dispatch receives the canonical `-fast` model; the adapter reads `fastRoute.upstreamModelId`
		// when it serializes the request, which the native-body test below asserts on the wire.
		assert.equal(captured.model.id, "openai-test-model-fast");
		assert.deepEqual(captured.model.fastRoute, serviceTierRoute("openai-test-model"));
	});

	it("preserves custom provider streaming for native OpenAI APIs on a fast route", async () => {
		const baseModel = createModel("openai", "openai-responses");
		const model: Model<Api> = {
			...baseModel,
			id: `${baseModel.id}-fast`,
			fastRoute: serviceTierRoute(baseModel.id),
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({});
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedOptions: SimpleStreamOptions | undefined;
		let capturedModel: Model<Api> | undefined;
		const nativeFetch = vi.fn(async (): Promise<Response> => {
			throw new Error("native OpenAI streaming should not be called for registered providers");
		});
		vi.stubGlobal("fetch", nativeFetch);

		modelRuntime.registerProvider("openai", {
			api: "openai-responses",
			streamSimple: (streamModel, _context, streamOptions) => {
				capturedModel = streamModel;
				capturedOptions = streamOptions;
				return createDoneStream(streamModel);
			},
		});
		registeredProviders.push({ registry: modelRuntime, provider: "openai" });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, { sessionId: session.sessionId });
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(nativeFetch).not.toHaveBeenCalled();
			expect((capturedOptions as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
				FAST_MODEL_SERVICE_TIER,
			);
			// An extension stream owns its own transport, so it receives the canonical model and the
			// service tier, and decides for itself how to route them.
			expect(capturedModel?.id).toBe(`${baseModel.id}-fast`);
			expect(capturedModel?.fastRoute).toEqual(serviceTierRoute(baseModel.id));
		} finally {
			session.dispose();
			modelRuntime.unregisterProvider("openai");
			registeredProviders = registeredProviders.filter(
				(entry) => entry.registry !== modelRuntime || entry.provider !== "openai",
			);
		}
	});

	it("sends the base model ID plus a priority service tier in native OpenAI Responses bodies", async () => {
		const baseModel = createModel("openai", "openai-responses");
		const model: Model<Api> = {
			...baseModel,
			id: `${baseModel.id}-fast`,
			fastRoute: serviceTierRoute(baseModel.id),
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({});
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedPayload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				capturedPayload = JSON.parse(await bodyToText(init?.body)) as Record<string, unknown>;
				const completedEvent = {
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						service_tier: FAST_MODEL_SERVICE_TIER,
						usage: {
							input_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 0,
							total_tokens: 0,
						},
					},
				};
				return new Response(`data: ${JSON.stringify(completedEvent)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, { sessionId: session.sessionId });
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(capturedPayload).toMatchObject({
				model: baseModel.id,
				service_tier: FAST_MODEL_SERVICE_TIER,
			});
		} finally {
			session.dispose();
		}
	});

	it("routes a renamed provider on the shared Codex transport with the base model in the routing hint", async () => {
		const provider = "codex-proxy";
		const api = "openai-codex-responses" as const;
		const baseModelId = "gpt-5.6-sol";
		const model: Model<Api> = {
			...createModel(provider, api),
			id: `${baseModelId}-fast`,
			baseUrl: "https://monitor.example/backend-api",
			fastRoute: serviceTierRoute(baseModelId),
		};
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(provider, async () => ({
			type: "api_key",
			key: `header.${tokenPayload}.signature`,
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(provider, {
			api,
			apiKey: "credential-fallback",
			baseUrl: model.baseUrl,
			models: [model],
		});
		registeredProviders.push({ registry: modelRuntime, provider });
		let capturedUrl: string | undefined;
		let capturedHeaders: Headers | undefined;
		let capturedPayload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				capturedHeaders = new Headers(init?.headers);
				const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
				capturedPayload = JSON.parse(
					capturedHeaders.get("content-encoding") === "zstd"
						? zstdDecompressSync(bytes).toString("utf8")
						: new TextDecoder().decode(bytes),
				) as Record<string, unknown>;
				const completedEvent = {
					type: "response.completed",
					response: {
						id: "resp_alias",
						status: "completed",
						service_tier: FAST_MODEL_SERVICE_TIER,
						usage: {
							input_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 0,
							total_tokens: 0,
						},
					},
				};
				return new Response(`data: ${JSON.stringify(completedEvent)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			const stream = await session.agent.streamFunction(
				model,
				{ messages: [] },
				{ sessionId: session.sessionId, transport: "sse" },
			);
			await stream.result();

			expect(capturedUrl).toBe("https://monitor.example/backend-api/codex/responses");
			expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_ROUTE_ORIGINATOR);
			expect(capturedHeaders?.get(CODEX_FAST_ROUTE_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
			expect(capturedPayload).toMatchObject({ model: baseModelId, service_tier: FAST_MODEL_SERVICE_TIER });
		} finally {
			session.dispose();
		}
	});
});
