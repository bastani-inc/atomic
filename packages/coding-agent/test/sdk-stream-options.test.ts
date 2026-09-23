import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AuthResult,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@bastani/pi-ai";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.js";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});
	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	/** A selected model whose explicit route metadata puts it on the OpenAI priority fast route. */
	function fastRouteModel(): Model<Api> {
		const base = createModel("openai-responses");
		return {
			...base,
			id: `${base.id}-fast`,
			fastRoute: { baseModelId: base.id, upstreamModelId: base.id, serviceTier: "priority" },
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
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

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionSource?: string,
		authResult?: AuthResult,
		capturedRequest?: { model?: Model<Api> },
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		if (extensionSource) {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "headers.ts"), extensionSource);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				if (capturedRequest) capturedRequest.model = requestModel;
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api);
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					const done = createDoneStream(api);
					stream.end(await done.result());
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		if (authResult !== undefined) vi.spyOn(modelRuntime, "getAuth").mockResolvedValue(authResult);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, requestOptions);
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards provider stream events to extensions (#9784)", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const received: unknown[] = [];
		(globalThis as { __providerStreamEvents?: unknown[] }).__providerStreamEvents = received;
		try {
			const options = await captureStreamOptions(
				"openai-completions",
				{},
				{},
				`export default function (pi) {
					pi.on("provider_stream_event", (event) => {
						globalThis.__providerStreamEvents.push(event);
					});
				}`,
				undefined,
				undefined,
				providerEvent,
			);

			assert.equal(typeof options?.onProviderStreamEvent, "function");
			assert.deepEqual(received, [
				{
					type: "provider_stream_event",
					provider: "capture-provider",
					api: "openai-completions",
					model: "capture-model",
					data: providerEvent,
				},
			]);
		} finally {
			delete (globalThis as { __providerStreamEvents?: unknown[] }).__providerStreamEvents;
		}
	});

	it("defaults session prompt-cache retention to long", async () => {
		vi.stubEnv("PI_CACHE_RETENTION", undefined);
		const options = await captureStreamOptions("anthropic-messages", {});
		assert.equal(options?.cacheRetention, "long");
	});

	it.each(["short", "none", "long"] as const)("honors PI_CACHE_RETENTION=%s", async (retention) => {
		vi.stubEnv("PI_CACHE_RETENTION", retention);
		const options = await captureStreamOptions("anthropic-messages", {});
		assert.equal(options?.cacheRetention, retention);
	});

	it.each(["short", "none", "long"] as const)("preserves explicit %s over environment", async (retention) => {
		vi.stubEnv("PI_CACHE_RETENTION", "short");
		const requestOptions = { cacheRetention: retention, env: { PI_CACHE_RETENTION: "none" } };
		const options = await captureStreamOptions("anthropic-messages", {}, requestOptions);
		assert.equal(options?.cacheRetention, retention);
		assert.deepEqual(requestOptions, { cacheRetention: retention, env: { PI_CACHE_RETENTION: "none" } });
	});

	it("resolves request env over auth env over process env", async () => {
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		const auth: AuthResult = { auth: { apiKey: "test-key" }, env: { PI_CACHE_RETENTION: "none" } };
		const authOptions = await captureStreamOptions("anthropic-messages", {}, {}, undefined, auth);
		assert.equal(authOptions?.cacheRetention, "none");
		const options = await captureStreamOptions(
			"anthropic-messages",
			{},
			{ env: { PI_CACHE_RETENTION: "short" } },
			undefined,
			auth,
		);
		assert.equal(options?.cacheRetention, "short");
		assert.deepEqual(auth.env, { PI_CACHE_RETENTION: "none" });
	});

	it.each([
		["", "long"],
		["unexpected", "short"],
		[" LONG ", "short"],
	])("preserves provider env fallback for %j", async (value, retention) => {
		vi.stubEnv("PI_CACHE_RETENTION", value);
		const options = await captureStreamOptions("anthropic-messages", {});
		assert.equal(options?.cacheRetention, retention);
	});

	it("empty scoped env falls back to the process choice", async () => {
		vi.stubEnv("PI_CACHE_RETENTION", "short");
		const options = await captureStreamOptions("anthropic-messages", {}, { env: { PI_CACHE_RETENTION: "" } });
		assert.equal(options?.cacheRetention, "short");
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		assert.equal(options?.timeoutMs, 1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		assert.equal(options?.timeoutMs, 1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		assert.equal(options?.timeoutMs, 0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		assert.equal(options?.websocketConnectTimeoutMs, 1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		assert.equal(options?.websocketConnectTimeoutMs, 0);
	});

	it("forwards a duration-string stream deadline from settings", async () => {
		const options = await captureStreamOptions("openai-completions", { streamDeadlineMs: "30s" });

		assert.equal(options?.streamDeadlineMs, 30_000);
	});

	it("lets request streamDeadlineMs zero disable the configured deadline", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{ streamDeadlineMs: "5m" },
			{ streamDeadlineMs: 0 },
		);

		assert.equal(options?.streamDeadlineMs, 0);
	});

	it("rejects an unsupported stream deadline duration", () => {
		assert.throws(
			() => SettingsManager.inMemory({ streamDeadlineMs: "30d" }).getStreamDeadlineMs(),
			/Invalid streamDeadlineMs setting/,
		);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		assert.equal(options?.maxRetries, 2);
		assert.equal(options?.maxRetryDelayMs, 3000);
	});

	it("forwards per-request sampling params to extension providers", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{
				samplingParams: { top_p: 0.35, top_k: 40, vendor_sampler: "fast" },
			},
		);

		assert.deepEqual(options?.samplingParams, { top_p: 0.35, top_k: 40, vendor_sampler: "fast" });
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			`export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			}`,
		);

		assert.equal(options?.headers?.["x-provider"], "provider");
		assert.equal(options?.headers?.["x-model"], "model");
		assert.equal(options?.headers?.["x-explicit"], "explicit");
		assert.equal(options?.headers?.["x-hook"], "provider:model:explicit");
		assert.ok(options);
		assert.equal("transformHeaders" in options, false);
	});

	it("preserves null credential headers through extension-provider dispatch", async () => {
		const options = await captureStreamOptions("openai-completions", {}, {}, undefined, {
			auth: {
				apiKey: "credential-key",
				headers: { Authorization: null, "x-api-key": null, "x-credential": "present" },
			},
		});

		assert.equal(options?.apiKey, "credential-key");
		assert.equal(options?.headers?.Authorization, null);
		assert.equal(options?.headers?.["x-api-key"], null);
		assert.equal(options?.headers?.["x-credential"], "present");
	});

	it("uses a credential-derived endpoint and null headers for workflow and subagent SDK sessions", async () => {
		const captured: { model?: Model<Api> } = {};
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			undefined,
			{
				auth: {
					apiKey: "credential-key",
					baseUrl: "https://credential.example/v1",
					headers: { Authorization: null, "x-credential": "present" },
				},
				env: { HTTPS_PROXY: "https://credential-proxy.example" },
			},
			captured,
		);

		assert.equal(captured.model?.baseUrl, "https://credential.example/v1");
		assert.equal(options?.headers?.Authorization, null);
		assert.equal(options?.headers?.["x-credential"], "present");
		assert.deepEqual(options?.env, { HTTPS_PROXY: "https://credential-proxy.example" });
	});

	it("uses a credential-derived baseUrl for native Codex fast-route dispatch", async () => {
		const model: Model<Api> = { ...fastRouteModel(), provider: "openai" };
		const modelRuntime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json")),
		);
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue({
			auth: { apiKey: "credential-key", baseUrl: "https://credential.example/v1" },
		});
		let dispatchedUrl: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
				dispatchedUrl = String(input);
				const completed = {
					type: "response.completed",
					response: {
						id: "resp_test",
						status: "completed",
						usage: {
							input_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 0,
							total_tokens: 0,
						},
					},
				};
				return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] });
			await stream.result();
			assert.ok(typeof dispatchedUrl === "string");
			assert.match(dispatchedUrl, /^https:\/\/credential\.example\/v1\//u);
		} finally {
			session.dispose();
		}
	});

	it("rejects authHeader providers before Codex fast-route dispatch when credentials are missing", async () => {
		const model: Model<Api> = { ...fastRouteModel(), provider: "openai" };
		const modelRuntime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json")),
		);
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue(undefined);
		const streamSimple = vi.fn(() => createDoneStream(model.api));
		modelRuntime.registerProvider("openai", {
			api: model.api,
			baseUrl: model.baseUrl,
			authHeader: true,
			streamSimple,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			await assert.rejects(session.agent.streamFunction(model, { messages: [] }), (error: Error) => {
				assert.ok(error.message.includes(`No API key found for "${model.provider}"`));
				return true;
			});
			assert.equal(streamSimple.mock.calls.length, 0);
		} finally {
			session.dispose();
			modelRuntime.unregisterProvider("openai");
		}
	});

	it("rejects native Codex fast-route dispatch when provider auth is unresolved", async () => {
		const model: Model<Api> = { ...fastRouteModel(), provider: "openai" };
		const modelRuntime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json")),
		);
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue(undefined);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			await assert.rejects(session.agent.streamFunction(model, { messages: [] }), (error: Error) => {
				assert.ok(error.message.includes(`No API key found for "${model.provider}"`));
				return true;
			});
		} finally {
			session.dispose();
		}
	});
});
