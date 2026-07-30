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
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let previousCodexFastModeEnv: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		previousCodexFastModeEnv = process.env[ENV_CODEX_FAST_MODE];
		delete process.env[ENV_CODEX_FAST_MODE];
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		if (previousCodexFastModeEnv === undefined) delete process.env[ENV_CODEX_FAST_MODE];
		else process.env[ENV_CODEX_FAST_MODE] = previousCodexFastModeEnv;
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
			streamSimple: (_requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
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

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
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

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});

	it("preserves null credential headers through extension-provider dispatch", async () => {
		const options = await captureStreamOptions("openai-completions", {}, {}, undefined, {
			auth: {
				apiKey: "credential-key",
				headers: { Authorization: null, "x-api-key": null, "x-credential": "present" },
			},
		});

		expect(options?.apiKey).toBe("credential-key");
		expect(options?.headers).toMatchObject({
			Authorization: null,
			"x-api-key": null,
			"x-credential": "present",
		});
	});

	it("uses a credential-derived baseUrl for native Codex fast-mode dispatch", async () => {
		const model: Model<Api> = { ...createModel("openai-responses"), provider: "openai" };
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
			settingsManager: SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] });
			await stream.result();
			expect(dispatchedUrl).toMatch(/^https:\/\/credential\.example\/v1\//u);
		} finally {
			session.dispose();
		}
	});

	it("rejects authHeader providers before Codex fast-mode dispatch when credentials are missing", async () => {
		const model: Model<Api> = { ...createModel("openai-responses"), provider: "openai" };
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
			settingsManager: SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			await expect(session.agent.streamFunction(model, { messages: [] })).rejects.toThrow(
				`No API key found for "${model.provider}"`,
			);
			expect(streamSimple).not.toHaveBeenCalled();
		} finally {
			session.dispose();
			modelRuntime.unregisterProvider("openai");
		}
	});

	it("rejects native Codex fast-mode dispatch when provider auth is unresolved", async () => {
		const model: Model<Api> = { ...createModel("openai-responses"), provider: "openai" };
		const modelRuntime = getModelRuntime(
			await createModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json")),
		);
		vi.spyOn(modelRuntime, "getAuth").mockResolvedValue(undefined);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			await expect(session.agent.streamFunction(model, { messages: [] })).rejects.toThrow(
				`No API key found for "${model.provider}"`,
			);
		} finally {
			session.dispose();
		}
	});
});
