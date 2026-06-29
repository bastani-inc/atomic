import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
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
		settings: { httpIdleTimeoutMs?: number; websocketConnectTimeoutMs?: number },
		requestOptions: SimpleStreamOptions = {},
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, requestOptions);
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

	it("forwards the Copilot API version header through normal stream options", async () => {
		const api: Api = "openai-completions";
		const model: Model<Api> = {
			...createModel(api),
			id: "gpt-5.5",
			name: "GitHub Copilot GPT-5.5",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com/v1",
			contextWindow: 400_000,
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			await session.agent.streamFn(model, { messages: [] });
			expect(capturedOptions?.headers?.["X-GitHub-Api-Version"]).toBe("2026-06-01");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("lets a per-request lowercase Copilot API version header replace the canonical auth header", async () => {
		const api: Api = "openai-completions";
		const model: Model<Api> = {
			...createModel(api),
			id: "gpt-5.5",
			name: "GitHub Copilot GPT-5.5",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com/v1",
			contextWindow: 400_000,
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, { headers: { "x-github-api-version": "request-version" } });
			expect(capturedOptions?.headers?.["x-github-api-version"]).toBe("request-version");
			expect(capturedOptions?.headers?.["X-GitHub-Api-Version"]).toBeUndefined();
			expect(
				Object.keys(capturedOptions?.headers ?? {}).filter((key) => key.toLowerCase() === "x-github-api-version"),
			).toEqual(["x-github-api-version"]);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});
});
