import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CODEX_FAST_MODE_SERVICE_TIER } from "../src/core/codex-fast-mode.ts";
import { CODEX_FAST_MODE_ORIGINATOR, CODEX_FAST_MODE_ROUTING_HEADER } from "../src/core/codex-fast-mode-transport.ts";
import type { OrchestrationContext } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedFastModeRequest {
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

const workflowContext: OrchestrationContext = {
	kind: "workflow-stage",
	workflowRunId: "run-1",
	workflowStageId: "stage-1",
	workflowStageName: "Stage 1",
	constraints: {
		disableWorkflowTool: true,
	},
};

describe("createAgentSession codex fast mode", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let registeredProviders: Array<{ registry: ModelRuntime; provider: string }>;
	let previousCodexFastModeEnv: string | undefined;

	beforeEach(() => {
		previousCodexFastModeEnv = process.env[ENV_CODEX_FAST_MODE];
		delete process.env[ENV_CODEX_FAST_MODE];
		tempDir = join(tmpdir(), `atomic-sdk-codex-fast-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		if (previousCodexFastModeEnv === undefined) {
			delete process.env[ENV_CODEX_FAST_MODE];
		} else {
			process.env[ENV_CODEX_FAST_MODE] = previousCodexFastModeEnv;
		}
	});

	async function captureFastModeRequest(options: {
		provider: string;
		api?: Api;
		settings: { chat: boolean; workflow: boolean };
		orchestrationContext?: OrchestrationContext;
		payload?: Record<string, unknown>;
		fastModelIds?: string[];
		useBuiltInDispatch?: boolean;
	}): Promise<CapturedFastModeRequest> {
		const api = options.api ?? ("openai-responses" as Api);
		const model = createModel(options.provider, api);
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
		const settingsManager = SettingsManager.inMemory({ codexFastMode: options.settings });
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
			orchestrationContext: options.orchestrationContext,
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

	it("rewrites entitled Copilot requests across API paths without adding Codex request fields", async () => {
		for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
			const captured = await captureFastModeRequest({
				provider: "github-copilot",
				api,
				settings: { chat: true, workflow: false },
				fastModelIds: ["github-copilot-test-model-fast"],
				payload: { model: "github-copilot-test-model", messages: [] },
			});

			assert.equal(captured.model.id, "github-copilot-test-model-fast");
			assert.equal("serviceTier" in (captured.options ?? {}), false);
			assert.deepEqual(captured.payload, { model: "github-copilot-test-model-fast", messages: [] });
			assert.equal("service_tier" in (captured.payload as Record<string, unknown>), false);
			assert.equal("speed" in (captured.payload as Record<string, unknown>), false);
		}
	});

	it("keeps entitled Copilot requests on the built-in model runtime dispatch path", async () => {
		const captured = await captureFastModeRequest({
			provider: "github-copilot",
			api: "anthropic-messages",
			settings: { chat: true, workflow: false },
			fastModelIds: ["github-copilot-test-model-fast"],
			payload: { model: "github-copilot-test-model", messages: [] },
			useBuiltInDispatch: true,
		});

		assert.equal(captured.model.id, "github-copilot-test-model-fast");
		assert.equal("serviceTier" in (captured.options ?? {}), false);
		assert.equal(captured.options?.headers, undefined);
		assert.deepEqual(captured.payload, { model: "github-copilot-test-model-fast", messages: [] });
		assert.equal("service_tier" in (captured.payload as Record<string, unknown>), false);
		assert.equal("speed" in (captured.payload as Record<string, unknown>), false);
	});

	it("preserves unentitled Copilot requests when fast mode is enabled", async () => {
		const payload = { model: "github-copilot-test-model", messages: [] };
		const captured = await captureFastModeRequest({
			provider: "github-copilot",
			api: "anthropic-messages",
			settings: { chat: true, workflow: false },
			fastModelIds: ["other-model-fast"],
			payload,
		});

		assert.equal(captured.model.id, "github-copilot-test-model");
		assert.strictEqual(captured.payload, payload);
	});

	it("preserves entitled Copilot requests when fast mode is disabled", async () => {
		const payload = { model: "github-copilot-test-model", messages: [] };
		const captured = await captureFastModeRequest({
			provider: "github-copilot",
			api: "anthropic-messages",
			settings: { chat: false, workflow: false },
			fastModelIds: ["github-copilot-test-model-fast"],
			payload,
		});

		assert.equal(captured.model.id, "github-copilot-test-model");
		assert.strictEqual(captured.payload, payload);
	});

	it("adds priority service tier for enabled chat requests", async () => {
		const captured = await captureFastModeRequest({
			provider: "openai",
			settings: { chat: true, workflow: false },
		});

		expect((captured.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
			CODEX_FAST_MODE_SERVICE_TIER,
		);
		expect(captured.payload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
	});

	it("preserves custom provider streaming for native OpenAI APIs when fast mode is enabled", async () => {
		const model = createModel("openai", "openai-responses");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } });
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedOptions: SimpleStreamOptions | undefined;
		const nativeFetch = vi.fn(async (): Promise<Response> => {
			throw new Error("native OpenAI streaming should not be called for registered providers");
		});
		vi.stubGlobal("fetch", nativeFetch);

		modelRuntime.registerProvider("openai", {
			api: "openai-responses",
			streamSimple: (_model, _context, streamOptions) => {
				capturedOptions = streamOptions;
				return createDoneStream(model);
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
				CODEX_FAST_MODE_SERVICE_TIER,
			);
		} finally {
			session.dispose();
			modelRuntime.unregisterProvider("openai");
			registeredProviders = registeredProviders.filter(
				(entry) => entry.registry !== modelRuntime || entry.provider !== "openai",
			);
		}
	});

	it("applies inherited chat fast mode environment to child sessions", async () => {
		const previous = process.env[ENV_CODEX_FAST_MODE];
		process.env[ENV_CODEX_FAST_MODE] = "chat=1;workflow=0";
		try {
			const captured = await captureFastModeRequest({
				provider: "openai",
				settings: { chat: false, workflow: false },
			});

			expect((captured.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
				CODEX_FAST_MODE_SERVICE_TIER,
			);
			expect(captured.payload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_CODEX_FAST_MODE];
			} else {
				process.env[ENV_CODEX_FAST_MODE] = previous;
			}
		}
	});

	it("uses the workflow setting for workflow-stage requests", async () => {
		const disabled = await captureFastModeRequest({
			provider: "openai",
			settings: { chat: true, workflow: false },
			orchestrationContext: workflowContext,
		});
		expect((disabled.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBeUndefined();
		expect(disabled.payload).not.toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });

		const enabled = await captureFastModeRequest({
			provider: "openai",
			settings: { chat: false, workflow: true },
			orchestrationContext: workflowContext,
		});
		expect((enabled.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
			CODEX_FAST_MODE_SERVICE_TIER,
		);
		expect(enabled.payload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
	});

	it("does not apply fast mode to GitHub Copilot", async () => {
		const captured = await captureFastModeRequest({
			provider: "github-copilot",
			settings: { chat: true, workflow: true },
		});

		expect((captured.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBeUndefined();
		expect(captured.payload).not.toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
	});

	it("sends priority service tier in native OpenAI Responses request bodies", async () => {
		const model = createModel("openai", "openai-responses");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const settingsManager = SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } });
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
						service_tier: CODEX_FAST_MODE_SERVICE_TIER,
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
			expect(capturedPayload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
		} finally {
			session.dispose();
		}
	});

	it("routes a renamed provider through the shared Codex proxy transport", async () => {
		const provider = "codex-proxy";
		const api = "openai-codex-responses" as const;
		const model = {
			...createModel(provider, api),
			id: "gpt-5.6-sol",
			baseUrl: "https://monitor.example/backend-api",
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
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				capturedHeaders = new Headers(init?.headers);
				const completedEvent = {
					type: "response.completed",
					response: {
						id: "resp_alias",
						status: "completed",
						service_tier: CODEX_FAST_MODE_SERVICE_TIER,
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
			settingsManager: SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			const stream = await session.agent.streamFunction(
				model,
				{ messages: [] },
				{
					sessionId: session.sessionId,
					transport: "sse",
				},
			);
			await stream.result();

			expect(capturedUrl).toBe("https://monitor.example/backend-api/codex/responses");
			expect(capturedHeaders?.get("originator")).toBe(CODEX_FAST_MODE_ORIGINATOR);
			expect(capturedHeaders?.get(CODEX_FAST_MODE_ROUTING_HEADER)).toBe("model=gpt-5.6-sol;tier=priority");
		} finally {
			session.dispose();
		}
	});
	it("does not overwrite an existing provider payload service_tier", async () => {
		const captured = await captureFastModeRequest({
			provider: "openai",
			settings: { chat: true, workflow: false },
			payload: { service_tier: "default" },
		});

		expect(captured.payload).toEqual({ service_tier: "default" });
	});
});
