import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcModelRefreshResult } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";

function kimiModel(): Model<Api> {
	const auth = AuthStorage.inMemory({ "kimi-coding": { type: "api_key", key: "fake-kimi-key" } });
	const model = ModelRegistry.inMemory(auth).getAvailable().find((candidate) => candidate.provider === "kimi-coding");
	assert.ok(model);
	return model;
}

test("isolated host refresh atomically applies the engine model catalog without restart", async () => {
	const model = kimiModel();
	const scopedModels = [{ model, thinkingLevel: "high" as const }];
	let observedOptions: { timeoutMs?: number; force?: boolean; allowNetwork?: boolean } | undefined;
	const refreshResult: RpcModelRefreshResult = {
		aborted: false,
		errors: [{ provider: "dynamic-provider", message: "catalog unavailable" }],
		models: [model],
		scopedModels,
		customAuthProviders: [{ id: "dynamic-provider", name: "Dynamic Provider" }],
	};
	const client = {
		onEvent: () => () => {},
		getState: async () => ({
			thinkingLevel: "off" as const,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all" as const,
			followUpMode: "all" as const,
			sessionId: "test-session",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		}),
		requestInternal: async () => ({
			models: [], scopedModels: [],
			customAuthProviders: [{ id: "extension-provider", name: "Extension Provider" }],
		}),
		refreshModels: async (options: { timeoutMs?: number; force?: boolean; allowNetwork?: boolean }) => {
			observedOptions = options;
			return refreshResult;
		},
		loginProvider: async () => ({
			provider: "extension-provider",
			cancelled: false as const,
			credential: { type: "api_key" as const, key: "remote-key" },
			models: [], scopedModels: [], customAuthProviders: [],
		}),
		cancelLoginProvider: async () => {},
		getCommands: async () => [],
	} as unknown as RpcClient;
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const session = {
		modelRegistry: registry,
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const services = { cwd: process.cwd(), agentDir: process.cwd() };
	const createRuntime = (async () => { throw new Error("not used"); }) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(session, services as never, createRuntime);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);
	await runtime.initializeFromEngine();

	assert.deepEqual(registry.getAvailable(), []);
	assert.deepEqual(registry.getCustomApiKeyAuthProviders(), [{ id: "extension-provider", name: "Extension Provider" }]);
	assert.equal(registry.getProviderDisplayName("extension-provider"), "Extension Provider");
	const remoteAuth = registry.getCustomApiKeyAuth("extension-provider");
	assert.ok(remoteAuth);
	assert.equal(remoteAuth.name, "Extension Provider");
	assert.deepEqual(await remoteAuth.login({ signal: new AbortController().signal, prompt: async () => "unused" }), {
		type: "api_key", key: "remote-key",
	});
	const result = await registry.refresh({ allowNetwork: false, force: true, timeoutMs: 321 });

	assert.deepEqual(observedOptions, { allowNetwork: false, force: true, timeoutMs: 321 });
	assert.deepEqual(registry.getAvailable(), [model]);
	assert.equal(registry.find(model.provider, model.id), model);
	assert.equal(registry.hasConfiguredAuth(model), true);
	assert.deepEqual(session.scopedModels, scopedModels);
	assert.equal(result.aborted, false);
	assert.ok(result.errors instanceof Map);
	assert.equal(result.errors.get("dynamic-provider")?.message, "catalog unavailable");
});

test("an aborted isolated refresh does not replace the current model catalog", async () => {
	const model = kimiModel();
	let resolveRefresh!: (result: RpcModelRefreshResult) => void;
	const pending = new Promise<RpcModelRefreshResult>((resolve) => { resolveRefresh = resolve; });
	const client = {
		onEvent: () => () => {},
		getState: async () => ({
			thinkingLevel: "off" as const, isStreaming: false, isCompacting: false,
			steeringMode: "all" as const, followUpMode: "all" as const,
			sessionId: "test-session", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
		}),
		requestInternal: async () => ({ models: [], scopedModels: [], customAuthProviders: [] }),
		refreshModels: async () => pending,
		getCommands: async () => [],
	} as unknown as RpcClient;
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const session = {
		modelRegistry: registry, scopedModels: [], sessionFile: undefined,
		agent: { state: { model: undefined, thinkingLevel: "off", messages: [] }, steeringMode: "all", followUpMode: "all" },
	} as unknown as AgentSession;
	const createRuntime = (async () => { throw new Error("not used"); }) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(session, { cwd: process.cwd(), agentDir: process.cwd() } as never, createRuntime);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);
	await runtime.initializeFromEngine();
	const controller = new AbortController();
	const refresh = registry.refresh({ signal: controller.signal });
	controller.abort();

	assert.deepEqual(await refresh, { aborted: true, errors: new Map() });
	resolveRefresh({ aborted: false, errors: [], models: [model], scopedModels: [{ model }], customAuthProviders: [] });
	await Bun.sleep(0);
	assert.deepEqual(registry.getAvailable(), []);
	assert.deepEqual(session.scopedModels, []);
});

test("isolated host synchronizes authoritative engine fallback state and clears it after remote model selection", async () => {
	const model = kimiModel();
	type EngineState = Awaited<ReturnType<RpcClient["getState"]>>;
	let state: EngineState = {
		model,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "test-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
	const client = {
		onEvent: () => () => {},
		getState: async () => state,
		requestInternal: async () => ({ models: [model], scopedModels: [], customAuthProviders: [] }),
		setModel: async () => model,
		getCommands: async () => [],
	} as unknown as RpcClient;
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const session = {
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(process.cwd()),
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const createRuntime = (async () => { throw new Error("not used"); }) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
		[],
		"preliminary host warning",
		"configured-provider-unsupported",
	);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);

	await runtime.initializeFromEngine();
	assert.equal(runtime.modelFallbackMessage, undefined);
	assert.equal(runtime.modelFallbackReason, undefined);

	state = {
		...state,
		modelFallbackMessage: "authoritative unsupported warning",
		modelFallbackReason: "configured-provider-unsupported",
	};
	await runtime.initializeFromEngine();
	await runtime.initializeFromEngine();
	assert.equal(runtime.modelFallbackMessage, "authoritative unsupported warning");
	assert.equal(runtime.modelFallbackReason, "configured-provider-unsupported");

	state = {
		...state,
		model: undefined,
		modelFallbackMessage: "No models available",
		modelFallbackReason: "no-models-available",
	};
	await runtime.initializeFromEngine();
	assert.equal(runtime.session.model, undefined);
	assert.equal(runtime.modelFallbackMessage, "No models available");
	assert.equal(runtime.modelFallbackReason, "no-models-available");

	await runtime.session.setModel(model);
	assert.equal(runtime.modelFallbackMessage, undefined);
	assert.equal(runtime.modelFallbackReason, undefined);
});
