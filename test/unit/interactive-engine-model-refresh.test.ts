import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import type { RpcModelRefreshResult } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { sleep } from "../helpers/runtime.js";

async function kimiModel(): Promise<Model<Api>> {
	const auth = AuthStorage.inMemory({ "kimi-coding": { type: "api_key", key: "fake-kimi-key" } });
	const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
	const model = runtime.getAvailableSnapshot().find((candidate) => candidate.provider === "kimi-coding");
	assert.ok(model);
	return model;
}

test("isolated host treats an engine-published extension model as configured after refresh", async () => {
	const model = { ...(await kimiModel()), provider: "auth-free-extension", id: "published-model" };
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
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
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
			models: [],
			scopedModels: [],
			customAuthProviders: [{ id: "extension-provider", name: "Extension Provider" }],
		}),
		refreshModels: async (options: { timeoutMs?: number; force?: boolean; allowNetwork?: boolean }) => {
			observedOptions = options;
			return refreshResult;
		},
		loginProvider: async () => ({
			provider: "extension-provider",
			cancelled: false as const,
			type: "api_key" as const,
			models: [],
			scopedModels: [],
			customAuthProviders: [],
		}),
		cancelLoginProvider: async () => {},
		getCommands: async () => [],
	} as unknown as RpcClient;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const session = {
		modelRuntime,
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const services = { cwd: process.cwd(), agentDir: process.cwd() };
	const createRuntime = (async () => {
		throw new Error("not used");
	}) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(session, services as never, createRuntime);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);
	await runtime.initializeFromEngine();

	assert.deepEqual(modelRuntime.getAvailableSnapshot(), []);
	assert.equal(modelRuntime.hasConfiguredAuth(model.provider), false);
	const result = await (
		modelRuntime as unknown as {
			refresh(options: {
				allowNetwork?: boolean;
				force?: boolean;
				timeoutMs?: number;
			}): ReturnType<ModelRuntime["refresh"]>;
		}
	).refresh({ allowNetwork: false, force: true, timeoutMs: 321 });

	assert.deepEqual(observedOptions, { allowNetwork: false, force: true, timeoutMs: 321 });
	assert.deepEqual(modelRuntime.getAvailableSnapshot(), [model]);
	assert.equal(modelRuntime.getModel(model.provider, model.id), model);
	assert.equal(modelRuntime.hasConfiguredAuth(model.provider), true);
	assert.deepEqual(session.scopedModels, scopedModels);
	assert.equal(result.aborted, false);
	assert.ok(result.errors instanceof Map);
	assert.equal(result.errors.get("dynamic-provider")?.message, "catalog unavailable");
});

test("an aborted isolated refresh does not replace the current model catalog", async () => {
	const model = await kimiModel();
	let resolveRefresh!: (result: RpcModelRefreshResult) => void;
	const pending = new Promise<RpcModelRefreshResult>((resolve) => {
		resolveRefresh = resolve;
	});
	const client = {
		onEvent: () => () => {},
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
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
		requestInternal: async () => ({ models: [], scopedModels: [], customAuthProviders: [] }),
		refreshModels: async () => pending,
		getCommands: async () => [],
	} as unknown as RpcClient;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const session = {
		modelRuntime,
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const createRuntime = (async () => {
		throw new Error("not used");
	}) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
	);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);
	await runtime.initializeFromEngine();
	const controller = new AbortController();
	const refresh = modelRuntime.refresh({ signal: controller.signal });
	controller.abort();

	assert.deepEqual(await refresh, { aborted: true, errors: new Map() });
	resolveRefresh({ aborted: false, errors: [], models: [model], scopedModels: [{ model }], customAuthProviders: [] });
	await sleep(0);
	assert.deepEqual(modelRuntime.getAvailableSnapshot(), []);
	assert.deepEqual(session.scopedModels, []);
});

test("isolated host synchronizes authoritative engine fallback state and clears it after remote model selection", async () => {
	const model = await kimiModel();
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
		queuedMessagesPaused: false,
	};
	const client = {
		onEvent: () => () => {},
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		getState: async () => state,
		requestInternal: async () => ({ models: [model], scopedModels: [], customAuthProviders: [] }),
		setModel: async () => model,
		getCommands: async () => [],
	} as unknown as RpcClient;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const session = {
		modelRuntime,
		sessionManager: SessionManager.inMemory(process.cwd()),
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const createRuntime = (async () => {
		throw new Error("not used");
	}) as CreateAgentSessionRuntimeFactory;
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

test("isolated explicit cycle clears fallback only for a changed model despite an intervening model event", async () => {
	const previous = await kimiModel();
	const selected = { ...previous, id: `${previous.id}-next`, name: `${previous.name} Next` };
	type CycleBehavior = "changed" | "same" | "null" | "throw";
	let behavior: CycleBehavior = "changed";
	let session!: AgentSession;
	const client = {
		onEvent: () => () => {},
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		cycleModel: async () => {
			if (behavior === "throw") throw new Error("remote cycle failed");
			if (behavior === "null") return null;
			const model = behavior === "same" ? { ...session.model! } : selected;
			if (behavior === "changed") session.agent.state.model = model;
			return { model, thinkingLevel: behavior === "same" ? ("high" as const) : ("off" as const), isScoped: false };
		},
		getCommands: async () => [],
	} as unknown as RpcClient;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const sessionFixture = {
		modelRuntime,
		sessionManager: SessionManager.inMemory(process.cwd()),
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model: previous, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	};
	Object.defineProperty(sessionFixture, "model", { get: () => sessionFixture.agent.state.model });
	session = sessionFixture as unknown as AgentSession;
	const createRuntime = (async () => {
		throw new Error("not used");
	}) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
		[],
		"locked",
		"configured-provider-unsupported",
	);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);

	const changed = await runtime.session.cycleModel();
	assert.equal(changed?.model.id, selected.id);
	assert.equal(runtime.modelFallbackReason, undefined);

	for (const control of ["same", "null", "throw"] as const) {
		runtime.replaceModelFallback("locked", "configured-provider-unsupported");
		behavior = control;
		if (control === "throw") await assert.rejects(runtime.session.cycleModel(), /remote cycle failed/u);
		else await runtime.session.cycleModel();
		assert.equal(runtime.modelFallbackMessage, "locked", `${control} must preserve fallback`);
		assert.equal(runtime.modelFallbackReason, "configured-provider-unsupported");
	}
});
test("isolated session synchronization replaces each engine-selected session exactly once", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-isolated-session-sync-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionDir);
	const createPersistedSession = (text: string): string => {
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		const path = manager.getSessionFile();
		assert.ok(path);
		return path;
	};
	const firstSession = createPersistedSession("first");
	const secondSession = createPersistedSession("second");
	const authStorage = AuthStorage.inMemory();
	let runtimeCreations = 0;
	const startReasons: string[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		runtimeCreations += 1;
		if (options.sessionStartEvent) startReasons.push(options.sessionStartEvent.reason);
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			modelRuntime: await ModelRuntime.create({ credentials: authStorage, modelsPath: null }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const initial = await createRuntime({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	runtimeCreations = 0;
	startReasons.length = 0;
	let engineSessionFile = firstSession;
	const client = {
		onEvent: () => () => {},
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		getState: async () => ({
			thinkingLevel: "off" as const,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all" as const,
			followUpMode: "all" as const,
			sessionId: "engine-session",
			sessionFile: engineSessionFile,
			autoCompactionEnabled: true,
			messageCount: 1,
			pendingMessageCount: 0,
		}),
		requestInternal: async () => ({ models: [], scopedModels: [], customAuthProviders: [] }),
		switchSession: async (path: string) => {
			engineSessionFile = path;
			return { cancelled: false };
		},
		getCommands: async () => [],
		stop: async () => {},
	} as unknown as RpcClient;
	const local = new AgentSessionRuntime(initial.session, initial.services, createRuntime, initial.diagnostics);
	const runtime = new IsolatedInteractiveRuntime(local, createRuntime, client);
	let rebinds = 0;
	runtime.setRebindSession(async () => {
		rebinds += 1;
	});
	try {
		await runtime.initializeFromEngine();
		assert.equal(runtime.session.sessionManager.getSessionFile(), firstSession);
		assert.equal(runtimeCreations, 1, "initial engine binding must replace the local session once");
		assert.equal(rebinds, 1);
		assert.deepEqual(startReasons, ["resume"]);

		await runtime.switchSession(secondSession);
		assert.equal(runtime.session.sessionManager.getSessionFile(), secondSession);
		assert.equal(runtimeCreations, 2, "explicit engine switch must add exactly one local replacement");
		assert.equal(rebinds, 2);
		assert.deepEqual(startReasons, ["resume", "resume"]);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("isolated queue pause reaches the engine before abort and resumes remotely", async () => {
	let releasePause!: () => void;
	const pauseCommitted = new Promise<void>((resolve) => {
		releasePause = resolve;
	});
	const calls: string[] = [];
	const client = {
		onEvent: () => () => {},
		// Host-local engine lifecycle surface required by IsolatedInteractiveRuntime.
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		getState: async () => ({
			thinkingLevel: "off" as const,
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all" as const,
			followUpMode: "all" as const,
			sessionId: "test-session",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 1,
			queuedMessagesPaused: false,
		}),
		requestInternal: async (command: { type: string }) => {
			if (command.type === "get_available_models") return { models: [], scopedModels: [], customAuthProviders: [] };
			calls.push(command.type);
			if (command.type === "pause_queued_messages") await pauseCommitted;
			if (command.type === "resume_queued_messages") return { released: true };
			return undefined;
		},
		abort: async () => {
			calls.push("abort");
		},
		getCommands: async () => [],
	} as unknown as RpcClient;
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const session = {
		modelRuntime,
		scopedModels: [],
		sessionFile: undefined,
		sessionManager: {},
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	} as unknown as AgentSession;
	const createRuntime = (async () => {
		throw new Error("not used");
	}) as CreateAgentSessionRuntimeFactory;
	const localRuntime = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
	);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);
	await runtime.initializeFromEngine();

	runtime.session.pauseQueuedMessages();
	const abort = runtime.session.abort();
	await sleep(150);
	assert.deepEqual(calls, ["pause_queued_messages", "abort"]);
	assert.equal(runtime.session.queuedMessagesPaused, true);
	await abort;
	releasePause();
	assert.equal(await runtime.session.resumeQueuedMessages(), true);
	assert.deepEqual(calls, ["pause_queued_messages", "abort", "resume_queued_messages"]);
	assert.equal(runtime.session.queuedMessagesPaused, false);
});

test("isolated runtime applies the RPC compaction reason during resync", async () => {
	const model = await kimiModel();
	const state: Awaited<ReturnType<RpcClient["getState"]>> = {
		model,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: true,
		compactionReason: "overflow",
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "test-session",
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
	};
	const client = Object.assign(Object.create(RpcClient.prototype) as RpcClient, {
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		onInteractiveEngineMessage: () => () => {},
		getState: async () => state,
		requestInternal: async () => ({ models: [model], scopedModels: [], customAuthProviders: [] }),
		getCommands: async () => [],
	});
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const session = Object.assign({} as AgentSession, {
		modelRuntime,
		sessionManager: SessionManager.inMemory(process.cwd()),
		scopedModels: [],
		sessionFile: undefined,
		agent: {
			state: { model, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("unused");
	};
	const localRuntime = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
	);
	const runtime = new IsolatedInteractiveRuntime(localRuntime, createRuntime, client);

	await runtime.initializeFromEngine();

	assert.equal(runtime.session.isCompacting, true);
	assert.equal(runtime.session.compactionReason, "overflow");
});
