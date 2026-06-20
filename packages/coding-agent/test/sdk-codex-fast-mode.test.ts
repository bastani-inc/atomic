import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_CODEX_FAST_MODE } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CODEX_FAST_MODE_SERVICE_TIER } from "../src/core/codex-fast-mode.ts";
import type { OrchestrationContext } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface CapturedFastModeRequest {
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
		maxSubagentDepth: 0,
	},
};

describe("createAgentSession codex fast mode", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let registeredProviders: Array<{ registry: ModelRegistry; provider: string }>;
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
		settings: { chat: boolean; workflow: boolean };
		orchestrationContext?: OrchestrationContext;
		payload?: Record<string, unknown>;
	}): Promise<CapturedFastModeRequest> {
		const api = `codex-fast-capture-${options.provider}-${Math.random().toString(36).slice(2)}` as Api;
		const model = createModel(options.provider, api);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(options.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({ codexFastMode: options.settings });
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(options.provider, {
			api,
			streamSimple: (_model, _context, streamOptions) => {
				capturedOptions = streamOptions;
				return createDoneStream(model);
			},
		});
		registeredProviders.push({ registry: modelRegistry, provider: options.provider });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			orchestrationContext: options.orchestrationContext,
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, { sessionId: session.sessionId });
			const payload = await session.agent.onPayload?.(options.payload ?? { model: model.id }, model);
			return { options: capturedOptions, payload };
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(options.provider);
			registeredProviders = registeredProviders.filter((entry) => entry.registry !== modelRegistry || entry.provider !== options.provider);
		}
	}

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
		authStorage.setRuntimeApiKey("openai", "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } });
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedOptions: SimpleStreamOptions | undefined;
		const nativeFetch = vi.fn(async (): Promise<Response> => {
			throw new Error("native OpenAI streaming should not be called for registered providers");
		});
		vi.stubGlobal("fetch", nativeFetch);

		modelRegistry.registerProvider("openai", {
			api: "openai-responses",
			streamSimple: (_model, _context, streamOptions) => {
				capturedOptions = streamOptions;
				return createDoneStream(model);
			},
		});
		registeredProviders.push({ registry: modelRegistry, provider: "openai" });

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
			const stream = await session.agent.streamFn(model, { messages: [] }, { sessionId: session.sessionId });
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(nativeFetch).not.toHaveBeenCalled();
			expect((capturedOptions as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBe(
				CODEX_FAST_MODE_SERVICE_TIER,
			);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("openai");
			registeredProviders = registeredProviders.filter(
				(entry) => entry.registry !== modelRegistry || entry.provider !== "openai",
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
			provider: "openai-codex",
			settings: { chat: true, workflow: false },
			orchestrationContext: workflowContext,
		});
		expect((disabled.options as SimpleStreamOptions & { serviceTier?: string })?.serviceTier).toBeUndefined();
		expect(disabled.payload).not.toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });

		const enabled = await captureFastModeRequest({
			provider: "openai-codex",
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
		authStorage.setRuntimeApiKey("openai", "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({ codexFastMode: { chat: true, workflow: false } });
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedPayload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				capturedPayload = JSON.parse(await bodyToText(init?.body)) as Record<string, unknown>;
				return new Response("data: [DONE]\n\n", {
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
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFn(model, { messages: [] }, { sessionId: session.sessionId });
			const result = await stream.result();

			expect(result.stopReason).toBe("stop");
			expect(capturedPayload).toMatchObject({ service_tier: CODEX_FAST_MODE_SERVICE_TIER });
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
