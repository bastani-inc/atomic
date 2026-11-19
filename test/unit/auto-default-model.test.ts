/**
 * `model: "auto"` runs the user's configured default model (`defaultProvider`/`defaultModel`) at the default thinking
 * level, or the current session's model when no default is configured, with no routing or decision-model request.
 * Real model runtime, local providers only; no network is contacted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	resolveAutoModel,
	SessionManager,
	type Settings,
	SettingsManager,
} from "@bastani/atomic";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { Compile } from "typebox/compile";
import { afterEach, test, vi } from "vitest";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	clearDeprecationWarningsForTests,
	setDeprecationWarningSink,
} from "../../packages/coding-agent/src/utils/deprecation.js";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";
import { applyAgentConfig } from "../../packages/subagents/src/agents/agent-management-helpers.js";
import { readMergedSubagentSettings } from "../../packages/subagents/src/agents/agent-overrides.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { prepareSubagentArguments, SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createDurableStagePrimitive,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { loadWorkflowModule } from "../../packages/workflows/src/extension/workflow-module-loader.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { AgentSessionAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createAgentSessionAdapter, run as sdkRun } from "../../packages/workflows/src/sdk-surface.js";
import { admittedSessionAdapter } from "../../packages/workflows/src/workers/admission-binding.js";
import { workerStageAdapter } from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { createStageControlRegistry, createStore, run, workflow } from "./executor-shared.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

/** A real parent session and a real child or stage session against local providers. */
const REAL_SESSION_TIMEOUT_MS = 90_000;

const HOME = "home";
const LOCKED = "locked";
const DEFAULT_ID = `${HOME}/default-model`;
const SESSION_ID = `${HOME}/session-model`;
const FALLBACK_ID = `${HOME}/fallback-model`;
/** A failure the stage's fallback walk moves past. */
const UNAVAILABLE = "503 Service Unavailable: the model is overloaded";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	clearDeprecationWarningsForTests();
	setDurableBackend(undefined);
});

/** The console warnings that name a removed routing option. */
function routingWarnings(warn: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }): string[] {
	return warn.mock.calls
		.map((call) => String(call[0]))
		.filter((message) => /modelRouting|modelConstraints|taskNeeds|parallelSlot/.test(message));
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * The session store the SDK session adapter's sessions in `cwd` open, closed before the directory is removed: Windows
 * cannot delete a SQLite file a handle still holds, whatever state the run ended in.
 */
async function sdkSessionStore(cwd: string) {
	const store = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
	cleanups.push(() => store.close());
	return store;
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

interface ProviderRequest {
	readonly model: string;
	readonly reasoning: string | undefined;
}

/** Three available models and one whose provider has no credentials; every request is recorded. */
async function models(
	fixture: {
		readonly failing?: readonly string[];
		readonly textOnly?: readonly string[];
		/** The error the failing models' requests end with; a retryable overload by default. */
		readonly failure?: string;
	} = {},
) {
	const base: Model<"anthropic-messages"> = { ...getModel("anthropic", "claude-sonnet-4-5")!, reasoning: true };
	const model = (provider: string, id: string): Model<"anthropic-messages"> => ({
		...base,
		provider,
		id,
		name: id,
		...(fixture.textOnly?.includes(`${provider}/${id}`)
			? { input: ["text"] as Model<"anthropic-messages">["input"] }
			: {}),
	});
	const defaultModel = model(HOME, "default-model");
	const sessionModel = model(HOME, "session-model");
	const fallbackModel = model(HOME, "fallback-model");
	const lockedModel = model(LOCKED, "locked-model");
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: ProviderRequest[] = [];
	const streamSimple = (requestModel: Model<Api>, _context: unknown, options?: { reasoning?: string }) => {
		const fullId = `${requestModel.provider}/${requestModel.id}`;
		requests.push({ model: fullId, reasoning: options?.reasoning });
		const stream = createAssistantMessageEventStream();
		const failure = fixture.failing?.includes(fullId) ? (fixture.failure ?? UNAVAILABLE) : undefined;
		const message: AssistantMessage = {
			role: "assistant",
			content: failure ? [] : [{ type: "text", text: `done on ${fullId}` }],
			api: base.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: usage(),
			stopReason: failure ? "error" : "stop",
			...(failure ? { errorMessage: failure } : {}),
			timestamp: Date.now(),
		};
		if (failure) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	runtime.registerProvider(HOME, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "home-key",
		models: [defaultModel, sessionModel, fallbackModel],
		streamSimple,
	});
	runtime.registerProvider(LOCKED, { api: base.api, baseUrl: base.baseUrl, models: [lockedModel], streamSimple });
	cleanups.push(() => {
		runtime.unregisterProvider(HOME);
		runtime.unregisterProvider(LOCKED);
	});
	return {
		runtime,
		registry: new ModelRegistry(runtime),
		defaultModel,
		sessionModel,
		fallbackModel,
		lockedModel,
		requests,
	};
}

const WITH_DEFAULT: Settings = { defaultProvider: HOME, defaultModel: "default-model", defaultThinkingLevel: "high" };

// ---------------------------------------------------------------------------------------------------------------
// The SDK helper
// ---------------------------------------------------------------------------------------------------------------

test("resolveAutoModel picks the configured default model at the default thinking level", async () => {
	const m = await models();
	const available = m.registry.getAvailable();
	const fromDefault = resolveAutoModel({
		settings: WITH_DEFAULT,
		availableModels: available,
		sessionModel: m.sessionModel,
		sessionThinkingLevel: "low",
	});
	assert.equal(`${fromDefault?.model.provider}/${fromDefault?.model.id}`, DEFAULT_ID);
	assert.equal(fromDefault?.thinkingLevel, "high");

	const perModel = resolveAutoModel({
		settings: { ...WITH_DEFAULT, modelThinkingLevels: { [DEFAULT_ID]: "minimal" } },
		availableModels: available,
		sessionModel: m.sessionModel,
	});
	assert.equal(perModel?.thinkingLevel, "minimal");

	const callerEffort = resolveAutoModel({
		settings: WITH_DEFAULT,
		availableModels: available,
		sessionModel: m.sessionModel,
		thinkingLevel: "low",
	});
	assert.equal(`${callerEffort?.model.provider}/${callerEffort?.model.id}`, DEFAULT_ID);
	assert.equal(callerEffort?.thinkingLevel, "low");

	const unset = resolveAutoModel({ settings: { defaultProvider: HOME }, availableModels: available });
	assert.equal(unset, undefined);
	assert.equal(m.requests.length, 0);
});

test("resolveAutoModel falls back to the session model when no usable default is configured", async () => {
	const m = await models();
	const available = m.registry.getAvailable();
	for (const settings of [{}, { defaultProvider: LOCKED, defaultModel: "locked-model" }] satisfies Settings[]) {
		const selected = resolveAutoModel({
			settings,
			availableModels: available,
			sessionModel: m.sessionModel,
			sessionThinkingLevel: "low",
		});
		assert.equal(`${selected?.model.provider}/${selected?.model.id}`, SESSION_ID, JSON.stringify(settings));
		assert.equal(selected?.thinkingLevel, "low");
		const withEffort = resolveAutoModel({
			settings,
			availableModels: available,
			sessionModel: m.sessionModel,
			sessionThinkingLevel: "low",
			thinkingLevel: "minimal",
		});
		assert.equal(withEffort?.thinkingLevel, "minimal");
	}
	assert.equal(resolveAutoModel({ settings: {}, availableModels: available }), undefined);
	assert.equal(m.requests.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------------------------------------------

function worker(cwd: string, model: string | undefined, thinking?: string): AgentConfig {
	return {
		name: "worker",
		description: "auto fixture",
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		systemPrompt: "You are the auto-model fixture child.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
}

function executorFor(
	cwd: string,
	agent: AgentConfig,
	settings: Settings,
	runSync: NonNullable<NonNullable<ExecutorDeps["runtime"]>["runSync"]>,
	ctx: ExtensionContext,
) {
	const executor = createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
			getSettings: () => settings,
		} as Partial<ExecutorDeps["pi"]> as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { intercomBridge: { mode: "off" }, parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	});
	return (params: SubagentParamsLike) =>
		executor.execute("auto-default-test", params, new AbortController().signal, undefined, ctx);
}

/** The executor with its child runtime replaced, so a test sees exactly what a launch would run. */
async function launchFixture(options: { agentModel?: string; agentThinking?: string; settings: Settings }) {
	const m = await models();
	const cwd = tempDir("atomic-auto-default-subagent-");
	const agent = worker(cwd, options.agentModel, options.agentThinking);
	const runSync = vi.fn(
		async (_cwd: string, _agents: AgentConfig[], _name: string, task: string, _options: RunSyncOptions) =>
			({
				agent: "worker",
				task,
				status: "ok",
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				finalOutput: "done",
			}) satisfies SingleResult,
	);
	const decisionModel = vi.fn(() => SESSION_ID);
	const ctx = {
		cwd,
		model: m.sessionModel,
		thinkingLevel: "low",
		modelRegistry: m.registry,
		getDecisionModel: decisionModel,
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionId: () => "parent",
			getLeafId: () => null,
		},
		isProjectTrusted: () => true,
		hasUI: false,
	} as unknown as ExtensionContext;
	return { ...m, runSync, decisionModel, call: executorFor(cwd, agent, options.settings, runSync, ctx) };
}

const LAUNCH_MODES = ["single-call", "single-agent", "parallel-call", "parallel-agent"] as const;

function launchParams(mode: (typeof LAUNCH_MODES)[number], extra: Record<string, unknown> = {}): SubagentParamsLike {
	const own = mode.endsWith("call") ? { model: "auto" } : {};
	return mode.startsWith("single")
		? ({ agent: "worker", task: "Inspect the parser", ...own, ...extra } as SubagentParamsLike)
		: ({ tasks: [{ agent: "worker", task: "Inspect the parser", ...own, ...extra }] } as SubagentParamsLike);
}

for (const mode of LAUNCH_MODES) {
	test(`a ${mode} auto launch runs the configured default model and effort without any model request`, async () => {
		const f = await launchFixture({
			agentModel: mode.endsWith("agent") ? "auto" : undefined,
			settings: WITH_DEFAULT,
		});
		const result = await f.call(launchParams(mode));
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		assert.equal(f.runSync.mock.calls.length, 1);
		assert.equal(f.runSync.mock.calls[0]![4].modelOverride, `${DEFAULT_ID}:high`);
		assert.deepEqual(f.requests, [], "no routing or decision request reaches any provider");
		assert.equal(f.decisionModel.mock.calls.length, 0, "the decision model is never consulted");
	});

	test(`a ${mode} auto launch with no configured default runs the session model and effort`, async () => {
		const f = await launchFixture({ agentModel: mode.endsWith("agent") ? "auto" : undefined, settings: {} });
		const result = await f.call(launchParams(mode));
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		assert.equal(f.runSync.mock.calls[0]![4].modelOverride, `${SESSION_ID}:low`);
		assert.deepEqual(f.requests, []);
		assert.equal(f.decisionModel.mock.calls.length, 0);
	});
}

test("an agent's own thinking level is the caller's effort for its auto model", async () => {
	const f = await launchFixture({ agentModel: "auto", agentThinking: "minimal", settings: WITH_DEFAULT });
	await f.call(launchParams("single-agent"));
	assert.equal(f.runSync.mock.calls[0]![4].modelOverride, `${DEFAULT_ID}:minimal`);
});

test("explicit subagent models are unchanged by the default model", async () => {
	const f = await launchFixture({ settings: WITH_DEFAULT });
	await f.call({ agent: "worker", task: "Inspect", model: `${SESSION_ID}:xhigh` });
	assert.equal(f.runSync.mock.calls[0]![4].modelOverride, `${SESSION_ID}:xhigh`);
	assert.deepEqual(f.requests, []);
});

for (const mode of LAUNCH_MODES) {
	test(`a ${mode} launch still passing taskNeeds and modelConstraints runs with them ignored`, async () => {
		const legacy = {
			taskNeeds: { work: "coding", difficulty: "hard" },
			modelConstraints: { allowedModels: ["x/y"] },
		};
		const params = prepareSubagentArguments(launchParams(mode, legacy));
		assert.equal(Compile(SubagentParams).Check(params), true, "the tool schema accepts the call");
		const f = await launchFixture({
			agentModel: mode.endsWith("agent") ? "auto" : undefined,
			settings: WITH_DEFAULT,
		});
		const result = await f.call(params as SubagentParamsLike);
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		const options = f.runSync.mock.calls[0]![4];
		assert.equal(options.modelOverride, `${DEFAULT_ID}:high`);
		assert.equal(Object.hasOwn(options, "modelConstraints"), false);
		assert.deepEqual(f.requests, []);
	});
}

test("agent files and agent config updates that still set taskNeeds or modelConstraints load with them ignored", async () => {
	const dir = tempDir("atomic-auto-default-agents-");
	writeFileSync(
		join(dir, "legacy.md"),
		[
			"---",
			"name: legacy",
			"description: Legacy routing fields",
			"model: auto",
			"modelConstraints:",
			"  allowedModels:",
			"    - x/y",
			"taskNeeds:",
			"  work: coding",
			"---",
			"Body",
		].join("\n"),
	);
	const { agents, diagnostics } = await loadAgentsFromDirWithDiagnostics(dir, "user");
	assert.deepEqual(diagnostics, []);
	const legacy = agents.find((agent) => agent.name === "legacy");
	assert.equal(legacy?.model, "auto");
	assert.equal(Object.hasOwn(legacy!, "modelConstraints"), false);
	assert.equal(Object.hasOwn(legacy?.extraFields ?? {}, "modelConstraints"), false);
	assert.equal(Object.hasOwn(legacy?.extraFields ?? {}, "taskNeeds"), false);
	const updated = { ...legacy! };
	applyAgentConfig(updated, { modelConstraints: { allowedModels: ["x/y"] }, taskNeeds: { work: "coding" } });
	assert.equal(Object.hasOwn(updated, "modelConstraints"), false);
	assert.equal(Object.hasOwn(updated, "taskNeeds"), false);
});

test("subagent calls that still pass modelConstraints or taskNeeds warn once per option, not per call", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	for (let call = 0; call < 3; call++) {
		prepareSubagentArguments({ agent: "worker", task: "Task", modelConstraints: { allowedModels: ["x/y"] } });
		prepareSubagentArguments({ tasks: [{ agent: "worker", task: "Task", taskNeeds: { work: "coding" } }] });
	}
	const warnings = routingWarnings(warn);
	assert.equal(warnings.length, 2, warnings.join("\n"));
	assert.ok(warnings.some((message) => message.includes('"modelConstraints"')));
	assert.ok(warnings.some((message) => message.includes('"taskNeeds"')));
	for (const message of warnings) assert.match(message, /ignored/);
	prepareSubagentArguments({ agent: "worker", task: "Task" });
	assert.equal(routingWarnings(warn).length, 2, "a call without removed fields does not warn");
});

test("agent files that still set modelConstraints or taskNeeds warn once that the fields are ignored", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const dir = tempDir("atomic-auto-default-agent-warning-");
	writeFileSync(
		join(dir, "legacy.md"),
		[
			"---",
			"name: legacy",
			"description: Legacy",
			"model: auto",
			"modelConstraints:",
			"  allowedModels:",
			"    - x/y",
			"taskNeeds:",
			"  work: coding",
			"---",
			"Body",
		].join("\n"),
	);
	await loadAgentsFromDirWithDiagnostics(dir, "user");
	await loadAgentsFromDirWithDiagnostics(dir, "user");
	const warnings = routingWarnings(warn);
	assert.equal(warnings.length, 2, warnings.join("\n"));
	assert.ok(warnings.some((message) => message.includes('"modelConstraints"')));
	assert.ok(warnings.some((message) => message.includes('"taskNeeds"')));
});

test(
	"an auto subagent's child session runs on the configured default model and effort",
	async () => {
		const m = await models();
		const cwd = tempDir("atomic-auto-default-child-");
		const settingsManager = SettingsManager.inMemory({
			...WITH_DEFAULT,
			retry: { enabled: false },
			compaction: { enabled: false },
		});
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: m.runtime,
			model: m.sessionModel,
			thinkingLevel: "low",
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
		});
		cleanups.push(() => {
			parent.dispose();
			clearSubagentControls();
		});
		const parentContext = parent.extensionRunner.createContext();
		const ctx = {
			cwd,
			model: parent.model,
			thinkingLevel: parent.thinkingLevel,
			modelRegistry: m.registry,
			getDecisionModel: () => SESSION_ID,
			getChildSessionOptions: parentContext.getChildSessionOptions,
			sessionManager: parent.sessionManager,
			isProjectTrusted: () => true,
			hasUI: false,
		} as unknown as ExtensionContext;
		const agent = worker(cwd, "auto");
		const call = executorFor(
			cwd,
			agent,
			settingsManager.getSettings(),
			(runtimeCwd, _agents, _name, task, options) =>
				runSingleInProcess(runtimeCwd, agent, task, {
					...options,
					testSession: false,
					sessionDir: join(cwd, "children"),
				}),
			ctx,
		);
		const result = await call({ agent: "worker", task: "Reply done." });
		assert.notEqual(result.isError, true, JSON.stringify(result.content));
		const child = result.details?.results[0];
		assert.equal(child?.model, DEFAULT_ID, JSON.stringify(child));
		assert.equal(child?.thinking, "high");
		assert.deepEqual(
			m.requests.map((request) => request.model),
			[DEFAULT_ID],
			"the child's own turn is the only request",
		);
	},
	REAL_SESSION_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------------------------------------------
// Workflow stages
// ---------------------------------------------------------------------------------------------------------------

interface Admission {
	readonly model: string | undefined;
	readonly thinkingLevel: string | undefined;
}

async function stageFixture(settings: Settings, fixture: Parameters<typeof models>[0] = {}) {
	const m = await models(fixture);
	const catalog = workflowModelCatalogFromContext(
		{ model: m.sessionModel, thinkingLevel: "low", modelRegistry: m.registry, getDecisionModel: () => SESSION_ID },
		undefined,
		() => settings,
	);
	const admissions: Admission[] = [];
	const thinkingChanges: string[] = [];
	const adapters = {
		agentSession: {
			async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions) {
				admissions.push({
					model:
						options.model === undefined
							? undefined
							: typeof options.model === "string"
								? options.model
								: `${options.model.provider}/${options.model.id}`,
					thinkingLevel: options.thinkingLevel,
				});
				const created = makeMockSession({
					model: options.model,
					async prompt() {
						return "done";
					},
					getLastAssistantText: () => "done",
				}).session;
				const setThinkingLevel = created.setThinkingLevel.bind(created);
				created.setThinkingLevel = async (level) => {
					thinkingChanges.push(level);
					await setThinkingLevel(level);
				};
				return created;
			},
		},
	};
	return { ...m, models: catalog, admissions, thinkingChanges, adapters, store: createStore() };
}

test("an image task whose only model that sees images lacks credentials fails, naming why each model was skipped", async () => {
	const base: Model<"anthropic-messages"> = getModel("anthropic", "claude-sonnet-4-5")!;
	const vision: Model<"anthropic-messages"> = { ...base, provider: "logged-out", id: "vision", name: "vision" };
	const text: Model<"anthropic-messages"> = {
		...base,
		provider: "working",
		id: "text",
		name: "text",
		input: ["text"] as Model<"anthropic-messages">["input"],
	};
	const registry = {
		getAvailable: () => [text],
		getAll: () => [vision, text],
		hasConfiguredAuth: (model: { readonly provider: string }) => model.provider === "working",
	};
	const catalog = workflowModelCatalogFromContext(
		{ model: vision, thinkingLevel: "low", modelRegistry: registry as never },
		undefined,
		() => ({ defaultProvider: "working", defaultModel: "text" }),
	);
	const image = join(tempDir("atomic-auto-default-image-credentials-"), "reference.png");
	writeFileSync(image, "png");
	let creations = 0;
	const def = workflow({
		name: "auto-image-credentials",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("design", {
				prompt: "Match the reference.",
				model: "auto",
				reads: [image],
				fallbackModels: ["working/text"],
			});
			return {};
		},
	});
	const result = await run(
		def,
		{},
		{
			models: catalog,
			store: createStore(),
			adapters: {
				agentSession: {
					async create() {
						creations++;
						return makeMockSession({
							async prompt() {
								return "done";
							},
						}).session;
					},
				},
			},
		},
	);
	assert.equal(result.status, "failed", "a task no model can run never completes");
	assert.match(result.error ?? "", /reads images/);
	assert.match(result.error ?? "", /working\/text.*does not accept image input/);
	assert.match(result.error ?? "", /logged-out\/vision.*no credentials/);
	assert.equal(creations, 0, "no session opens");
});

test("auto never resolves to a default model whose provider has no credentials, even from a stale availability list", async () => {
	const m = await models();
	// The availability list still names the logged-out provider's default model; its credentials are gone.
	const registry = {
		getAvailable: () => [m.defaultModel, m.sessionModel],
		hasConfiguredAuth: (model: { readonly provider: string }) => model.provider !== HOME || false,
	};
	const loggedOut = workflowModelCatalogFromContext(
		{ model: m.sessionModel, thinkingLevel: "low", modelRegistry: registry as never },
		undefined,
		() => WITH_DEFAULT,
	);
	// Every HOME model is logged out here, so `auto` keeps the launching session's model.
	assert.deepEqual(loggedOut?.autoModel?.(), { model: m.sessionModel, thinkingLevel: "low" });
	const loggedIn = workflowModelCatalogFromContext(
		{
			model: m.sessionModel,
			thinkingLevel: "low",
			modelRegistry: { ...registry, hasConfiguredAuth: () => true } as never,
		},
		undefined,
		() => WITH_DEFAULT,
	);
	assert.deepEqual(loggedIn?.autoModel?.(), { model: m.defaultModel, thinkingLevel: "high" });
});

test("an auto stage runs the configured default model and effort with no model request", async () => {
	const f = await stageFixture(WITH_DEFAULT);
	const def = workflow({
		name: "auto-default-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("implement", { model: "auto" }).prompt("Implement the change.");
			await ctx.task("review", { prompt: "Review the change.", model: "auto" });
			return {};
		},
	});
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(f.admissions, [
		{ model: DEFAULT_ID, thinkingLevel: "high" },
		{ model: DEFAULT_ID, thinkingLevel: "high" },
	]);
	assert.deepEqual(f.requests, [], "no routing or decision request reaches any provider");
	assert.equal(f.store.runs()[0]?.stages[0]?.model, DEFAULT_ID);
});

test("an auto stage with no configured default runs the launching session's model and effort", async () => {
	const f = await stageFixture({});
	const def = workflow({
		name: "auto-session-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("implement", { model: "auto" }).prompt("Implement the change.");
			return {};
		},
	});
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(f.admissions, [{ model: SESSION_ID, thinkingLevel: "low" }]);
	assert.deepEqual(f.requests, []);
});

test("an auto stage keeps the effort its author sets", async () => {
	const f = await stageFixture(WITH_DEFAULT);
	const def = workflow({
		name: "auto-effort-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("implement", { model: "auto" });
			await stage.setThinkingLevel("minimal");
			await stage.prompt("Implement the change.");
			return {};
		},
	});
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.equal(f.admissions[0]?.model, DEFAULT_ID);
	assert.equal(f.thinkingChanges.at(-1), "minimal");
});

test("prompt and complete adapters of an auto stage see the model it stands for, never auto (#5377)", async () => {
	for (const method of ["prompt", "complete"] as const) {
		for (const deferred of [false, true]) {
			const f = await stageFixture(WITH_DEFAULT);
			const preparedCwd = join(tempDir("atomic-auto-default-prepared-worktree-"), "prepared-worktree");
			let selected: string | undefined;
			let selectedCwd: string | undefined;
			const ctx = createStageContext(
				makeOpts({
					models: f.models,
					stageOptions: { model: "auto" },
					...(deferred ? { stageOptionsReady: Promise.resolve({ model: "auto", cwd: preparedCwd }) } : {}),
					adapters:
						method === "prompt"
							? {
									prompt: {
										async prompt(_text, meta) {
											selected = String(meta?.stageOptions?.model);
											selectedCwd = meta?.stageOptions?.cwd;
											return "done";
										},
									},
								}
							: {
									complete: {
										async complete(_text, _options, meta) {
											selected = String(meta?.stageOptions?.model);
											selectedCwd = meta?.stageOptions?.cwd;
											return "done";
										},
									},
								},
				}),
			);
			assert.equal(await ctx[method]("Adapter task"), "done");
			assert.equal(selected, `${DEFAULT_ID}:high`);
			if (deferred) assert.equal(selectedCwd, preparedCwd);
			assert.deepEqual(f.requests, []);
			await ctx.__dispose();
		}
	}
});

test("explicit stage models and fallbackModels are unchanged by the default model", async () => {
	const f = await stageFixture(WITH_DEFAULT);
	const def = workflow({
		name: "explicit-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("explicit", { model: `${SESSION_ID}:xhigh`, fallbackModels: [DEFAULT_ID] }).prompt("Task");
			return {};
		},
	});
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(f.admissions, [{ model: SESSION_ID, thinkingLevel: "xhigh" }]);
});

test("stages, tasks, chains and parallel steps still passing removed routing fields run with them ignored", async () => {
	const f = await stageFixture(WITH_DEFAULT);
	const legacy = {
		taskNeeds: { work: "coding" },
		modelConstraints: { allowedModels: ["x/y"] },
		parallelSlot: { index: 0, count: 2 },
	};
	const def = workflow({
		name: "legacy-routing-fields",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stageOptions = { model: "auto", ...legacy } as Parameters<typeof ctx.stage>[1];
			await ctx.stage("stage", stageOptions).prompt("Task");
			await ctx.task("task", { prompt: "Task", ...stageOptions });
			await ctx.chain([{ name: "chain", prompt: "Task", ...legacy }], stageOptions);
			await ctx.parallel([{ name: "parallel", prompt: "Task", ...legacy }], { ...stageOptions, concurrency: 1 });
			return {};
		},
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.equal(f.admissions.length, 4);
	for (const admission of f.admissions) assert.deepEqual(admission, { model: DEFAULT_ID, thinkingLevel: "high" });
	assert.deepEqual(f.requests, []);
	const warnings = routingWarnings(warn);
	assert.equal(warnings.length, 3, `one warning per removed option, not per stage:\n${warnings.join("\n")}`);
	for (const option of ["taskNeeds", "modelConstraints", "parallelSlot"])
		assert.ok(
			warnings.some((message) => message.includes(`"${option}"`)),
			option,
		);
});

for (const textOnly of [[DEFAULT_ID], [DEFAULT_ID, SESSION_ID], []] as const) {
	test(`an auto task that reads images with ${textOnly.length === 0 ? "an image-capable default" : textOnly.length === 1 ? "a text-only default" : "text-only default and session models"} runs on a model that sees them`, async () => {
		const f = await stageFixture(WITH_DEFAULT, { textOnly });
		const dir = tempDir("atomic-auto-default-images-");
		const image = join(dir, "reference.png");
		writeFileSync(image, "png");
		const def = workflow({
			name: "auto-reads-images",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("design", { prompt: "Match the reference.", model: "auto", reads: [image] });
				await ctx.task("plain", { prompt: "No images here.", model: "auto" });
				return {};
			},
		});
		const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
		if (textOnly.length === 2) {
			assert.equal(result.status, "failed");
			assert.match(result.error ?? "", /does not accept image input/);
			assert.match(result.error ?? "", /defaultModel/);
			assert.deepEqual(f.admissions, [], "no session opens on a model that cannot see the images");
		} else {
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(f.admissions, [
				textOnly.length === 1
					? { model: SESSION_ID, thinkingLevel: undefined }
					: { model: DEFAULT_ID, thinkingLevel: "high" },
				{ model: DEFAULT_ID, thinkingLevel: "high" },
			]);
		}
		assert.deepEqual(f.requests, []);
	});
}

test("through the SDK session adapter, an auto task that reads images runs on the session's model when the default cannot see them", async () => {
	for (const textOnly of [[DEFAULT_ID], [DEFAULT_ID, SESSION_ID]] as const) {
		const f = await stageFixture(WITH_DEFAULT, { textOnly });
		const sdk = createAgentSessionAdapter({
			modelRuntime: f.runtime,
			settingsManager: SettingsManager.inMemory(WITH_DEFAULT),
			model: f.sessionModel,
		});
		const image = join(tempDir("atomic-auto-default-sdk-image-"), "reference.png");
		writeFileSync(image, "png");
		const def = workflow({
			name: "sdk-auto-reads-images",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("design", { prompt: "Match the reference.", model: "auto", reads: [image] });
				return {};
			},
		});
		const result = await run(
			def,
			{},
			{
				adapters: { agentSession: { ...f.adapters.agentSession, autoModel: sdk.autoModel } },
				store: f.store,
			},
		);
		if (textOnly.length === 1) {
			assert.equal(result.status, "completed", result.error);
			assert.equal(f.admissions[0]?.model, SESSION_ID);
		} else {
			assert.equal(result.status, "failed");
			assert.match(result.error ?? "", /does not accept image input/);
			assert.deepEqual(f.admissions, []);
		}
	}
});

test(
	"without a model catalog, an auto task that reads images never falls back to a listed model that cannot see them",
	async () => {
		const m = await models({ textOnly: [FALLBACK_ID] });
		const cwd = tempDir("atomic-auto-default-sdk-image-fallback-");
		mkdirSync(join(cwd, "agent"), { recursive: true });
		const image = join(cwd, "reference.png");
		writeFileSync(image, "png");
		const sdk = createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionStore: await sdkSessionStore(cwd),
			modelRuntime: m.runtime,
			settingsManager: SettingsManager.inMemory({
				...WITH_DEFAULT,
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		const attempts: string[] = [];
		const def = workflow({
			name: "sdk-auto-image-fallback",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("design", {
					prompt: "Match the reference.",
					model: "auto",
					reads: [image],
					fallbackModels: [FALLBACK_ID],
				});
				return {};
			},
		});
		const result = await sdkRun(
			def,
			{},
			{
				cwd,
				journal: { memory: true },
				store: createStore(),
				adapters: {
					agentSession: {
						...sdk,
						async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions, meta) {
							const id =
								typeof options.model === "string"
									? options.model
									: `${options.model?.provider}/${options.model?.id}`;
							attempts.push(id);
							if (id.startsWith(DEFAULT_ID)) throw new Error("404 model_not_found: unknown model");
							return sdk.create(options, meta);
						},
					},
				},
			},
		);
		assert.notEqual(result.status, "completed", JSON.stringify(attempts));
		assert.equal(
			attempts.some((id) => id.startsWith(FALLBACK_ID)),
			false,
			`never admitted: ${attempts.join(", ")}`,
		);
		assert.deepEqual(m.requests, [], "no model turn runs on a model that cannot see the images");
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"without a model catalog, an auto task that reads images falls back to a listed model its runtime shows can see them",
	async () => {
		const m = await models();
		const cwd = tempDir("atomic-auto-default-sdk-image-fallback-ok-");
		mkdirSync(join(cwd, "agent"), { recursive: true });
		const image = join(cwd, "reference.png");
		writeFileSync(image, "png");
		const sdk = createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			sessionStore: await sdkSessionStore(cwd),
			modelRuntime: m.runtime,
			settingsManager: SettingsManager.inMemory({
				...WITH_DEFAULT,
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		const def = workflow({
			name: "sdk-auto-image-fallback-ok",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("design", {
					prompt: "Match the reference.",
					model: "auto",
					reads: [image],
					fallbackModels: [FALLBACK_ID],
					modelRuntime: m.runtime,
					tools: [],
				});
				return {};
			},
		});
		const result = await sdkRun(
			def,
			{},
			{
				cwd,
				journal: { memory: true },
				store: createStore(),
				adapters: {
					agentSession: {
						...sdk,
						async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions, meta) {
							const id =
								typeof options.model === "string"
									? options.model
									: `${options.model?.provider}/${options.model?.id}`;
							if (id.startsWith(DEFAULT_ID)) throw new Error("404 model_not_found: unknown model");
							return sdk.create(options, meta);
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			m.requests.map((request) => request.model),
			[FALLBACK_ID],
		);
	},
	REAL_SESSION_TIMEOUT_MS,
);

for (const fallbackSeesImages of [true, false]) {
	test(
		`without a model catalog, when an image task's first model turn fails, a fallback that ${fallbackSeesImages ? "sees images runs" : "cannot see images is refused"}`,
		async () => {
			const m = await models({
				failing: [DEFAULT_ID],
				failure: "404 model_not_found: unknown model",
				textOnly: fallbackSeesImages ? [] : [FALLBACK_ID],
			});
			const cwd = tempDir("atomic-auto-default-sdk-prompt-fallback-");
			mkdirSync(join(cwd, "agent"), { recursive: true });
			const image = join(cwd, "reference.png");
			writeFileSync(image, "png");
			// The runtime reaches the stage only through the adapter: no catalog, no task-level runtime.
			const sdk = createAgentSessionAdapter({
				cwd,
				agentDir: join(cwd, "agent"),
				sessionStore: await sdkSessionStore(cwd),
				modelRuntime: m.runtime,
				settingsManager: SettingsManager.inMemory({
					...WITH_DEFAULT,
					retry: { enabled: false },
					compaction: { enabled: false },
				}),
				builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			});
			const def = workflow({
				name: "sdk-auto-image-prompt-fallback",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.task("design", {
						prompt: "Match the reference.",
						model: "auto",
						reads: [image],
						fallbackModels: [FALLBACK_ID],
						tools: [],
					});
					return {};
				},
			});
			const result = await sdkRun(
				def,
				{},
				{
					cwd,
					journal: { memory: true },
					store: createStore(),
					adapters: { agentSession: sdk },
				},
			);
			const requested = m.requests.map((request) => request.model);
			if (fallbackSeesImages) {
				assert.equal(result.status, "completed", result.error);
				assert.deepEqual(requested, [DEFAULT_ID, FALLBACK_ID]);
			} else {
				assert.notEqual(result.status, "completed");
				assert.deepEqual(requested, [DEFAULT_ID], "the text-only fallback never runs");
			}
		},
		REAL_SESSION_TIMEOUT_MS,
	);
}

test("an auto task that reads images never falls back to a model that cannot see them", async () => {
	const f = await stageFixture(WITH_DEFAULT, { textOnly: [SESSION_ID] });
	const image = join(tempDir("atomic-auto-default-image-fallback-"), "reference.png");
	writeFileSync(image, "png");
	const create = f.adapters.agentSession.create;
	const attempts: string[] = [];
	const def = workflow({
		name: "auto-image-fallback",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("design", { prompt: "Match the reference.", model: "auto", reads: [image] });
			return {};
		},
	});
	const result = await run(
		def,
		{},
		{
			models: f.models,
			store: f.store,
			adapters: {
				agentSession: {
					async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions) {
						const id =
							typeof options.model === "string"
								? options.model
								: `${options.model?.provider}/${options.model?.id}`;
						attempts.push(id);
						if (id === DEFAULT_ID) throw new Error("404 model_not_found: unknown model");
						return create(options);
					},
				},
			},
		},
	);
	assert.notEqual(result.status, "completed");
	assert.equal(
		attempts.includes(SESSION_ID),
		false,
		`a text-only session model is never tried: ${attempts.join(", ")}`,
	);
	assert.deepEqual(f.admissions, []);
});

test(
	"a run whose host has no model blocks recoverably and resumes as the same run once a model is configured",
	async () => {
		const cwd = tempDir("atomic-auto-default-no-model-");
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		assert.equal((await modelRuntime.getAvailable()).length, 0);
		const adapter = createAgentSessionAdapter({
			cwd,
			modelRuntime,
			settingsManager: settings,
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			tools: ["read"],
		});
		const def = workflow({
			name: "auto-no-model",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("work", { model: "auto" }).prompt("Reply done.");
				return {};
			},
		});
		const store = createStore();
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			definitions: [def],
			adapters: { agentSession: adapter },
			store,
			jobs,
			cwd,
		});
		const launch = await runtime.dispatch({ action: "run", workflow: def.name, inputs: {} });
		assert.ok("runId" in launch && launch.runId);
		await jobs.get(launch.runId)?.promise;
		const blocked = store.run(launch.runId);
		assert.equal(blocked?.status, "running");
		assert.notEqual(blocked?.blockedAt, undefined);
		assert.equal(blocked?.resumable, true);
		assert.equal(blocked?.failureCode, "missing_api_key");
		const base = {
			...getModel("anthropic", "claude-sonnet-4-5")!,
			provider: HOME,
			id: "default-model",
			name: "default-model",
		};
		modelRuntime.registerProvider(HOME, {
			api: base.api,
			baseUrl: base.baseUrl,
			apiKey: "home-key",
			models: [base],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: base.api,
					provider: HOME,
					model: base.id,
					usage: usage(),
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		cleanups.push(() => modelRuntime.unregisterProvider(HOME));
		settings.applyOverrides(WITH_DEFAULT);
		const resumed = await runtime.resumeFailedRun(launch.runId);
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		if (!resumed.ok) return;
		assert.equal(resumed.runId, launch.runId, "the resumed run keeps its id");
		await jobs.get(resumed.runId)?.promise;
		const after = store.run(resumed.runId);
		assert.equal(after?.status, "completed", JSON.stringify(after?.error));
		assert.equal(after?.stages[0]?.model, DEFAULT_ID);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test("a live auto stage that is paused and resumed keeps its session and model", async () => {
	setDurableBackend(await createMemoryTestBackend());
	const settings: Settings = { ...WITH_DEFAULT };
	const f = await stageFixture(settings);
	const controls = createStageControlRegistry();
	const started = Promise.withResolvers<void>();
	let runId = "";
	let rejectPrompt: (error: Error) => void = () => {};
	const prompts: string[] = [];
	const sessions: string[] = [];
	const def = workflow({
		name: "auto-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			runId = ctx.runId ?? "";
			await ctx.stage("work", { model: "auto" }).prompt("Original task");
			return {};
		},
	});
	const running = run(
		def,
		{},
		{
			models: f.models,
			store: f.store,
			stageControlRegistry: controls,
			adapters: {
				agentSession: {
					async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions) {
						sessions.push(
							typeof options.model === "string"
								? options.model
								: `${options.model?.provider}/${options.model?.id}`,
						);
						return makeMockSession({
							model: options.model,
							async prompt(text) {
								prompts.push(text);
								if (prompts.length === 1) {
									started.resolve();
									return new Promise<string>((_, reject) => {
										rejectPrompt = reject;
									});
								}
								return "done";
							},
							async abort() {
								rejectPrompt(new Error("paused"));
							},
						}).session;
					},
				},
			},
		},
	);
	await started.promise;
	const handle = controls.forRun(runId)[0];
	assert.ok(handle);
	await handle.pause();
	// The default changes while the stage is paused: the resumed stage keeps the session it already has.
	settings.defaultModel = "fallback-model";
	await handle.resume("Resumed task");
	const result = await running;
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(prompts, ["Original task", "Resumed task"]);
	assert.deepEqual(sessions, [DEFAULT_ID]);
	assert.deepEqual(f.requests, []);
});

test("a restored stage checkpoint that still carries a legacy routerSelection replays and reruns auto on the default model", async () => {
	const f = await stageFixture(WITH_DEFAULT);
	const backend = await JournalTestBackend.create();
	await backend.commitWorkflowRegistration({
		workflowId: "auto",
		name: "auto",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	await recordStageSessionCheckpoint(
		{ backend, workflowId: "auto", nextCheckpointId: () => "cp", nextReplayKey: () => "stage:test" },
		{
			id: "s",
			name: "task",
			status: "running",
			parentIds: [],
			toolEvents: [],
			replayKey: "stage:test",
			sessionId: "synthetic-session",
			model: "x/old-routed",
		},
	);
	const written = await backend.reopen();
	const recorded = written.listCheckpoints("auto")[0];
	assert.ok(recorded?.kind === "stage");
	// A record written before routing was removed carries the routed selection.
	await written.commitCheckpoint({
		...recorded,
		checkpointId: "legacy",
		routerSelection: { model: "x/old-routed", effort: null },
	} as typeof recorded);
	const restored = await written.reopen();
	const decoded = restored.listCheckpoints("auto").find((checkpoint) => checkpoint.checkpointId === "legacy");
	assert.ok(decoded?.kind === "stage");
	const seen: object[] = [];
	const stage = createDurableStagePrimitive({
		workflowId: "auto",
		backend: restored,
		nextReplayKey: () => "stage:test",
		stage: (_name, options) => {
			seen.push(options ?? {});
			// The saved session is synthetic: readmit the stage without reopening it.
			return createStageContext(
				makeOpts({ models: f.models, adapters: f.adapters, stageOptions: { model: "auto" } }),
			);
		},
	})("task", { model: "auto" });
	await stage.prompt("Original prompt");
	assert.equal(seen.length, 1);
	assert.equal(Object.hasOwn(seen[0]!, "routerSelection"), false, "the legacy selection never reaches the stage");
	assert.deepEqual(f.admissions, [{ model: DEFAULT_ID, thinkingLevel: "high" }]);
	await restored.commitCheckpoint({
		...decoded,
		checkpointId: "completed",
		output: "Saved result",
		result: "Saved result",
		topology: { ...decoded.topology!, status: "completed" },
	});
	const replayed = createDurableStagePrimitive({
		workflowId: "auto",
		backend: restored,
		nextReplayKey: () => "stage:test",
		stage: () => {
			throw new Error("Replay must not construct a live stage");
		},
	})("task", { model: "auto" });
	assert.equal(await replayed.prompt("Ignored on replay"), "Saved result");
	assert.deepEqual(f.requests, []);
});

test("a TypeScript workflow definition that sets removed routing fields loads", () => {
	const dir = tempDir("atomic-auto-default-workflow-");
	const file = join(dir, "legacy-workflow.ts");
	writeFileSync(
		file,
		[
			'import { workflow } from "@bastani/atomic/workflows";',
			"export default workflow({",
			'  name: "legacy-routing-workflow",',
			'  description: "Sets removed routing fields",',
			"  inputs: {},",
			"  outputs: {},",
			"  run: async (ctx) => {",
			'    await ctx.stage("one", { model: "auto", taskNeeds: { work: "coding" }, modelConstraints: { allowedModels: ["x/y"] }, parallelSlot: { index: 0, count: 1 } }).prompt("Task");',
			"    return {};",
			"  },",
			"});",
		].join("\n"),
	);
	const loaded = loadWorkflowModule(file);
	const definition = loaded.default as { readonly name?: string } | undefined;
	assert.equal(definition?.name, "legacy-routing-workflow");
});

test(
	"the public SDK run() runs an auto stage on the configured default model through the default session adapter",
	async () => {
		const m = await models();
		const cwd = tempDir("atomic-auto-default-sdk-run-");
		mkdirSync(join(cwd, "agent"), { recursive: true });
		const def = workflow({
			name: "sdk-auto-stage",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement", { model: "auto", tools: [] });
				await stage.prompt("Reply done.");
				return {};
			},
		});
		const result = await sdkRun(
			def,
			{},
			{
				cwd,
				journal: { memory: true },
				store: createStore(),
				adapters: {
					agentSession: createAgentSessionAdapter({
						cwd,
						agentDir: join(cwd, "agent"),
						sessionStore: await sdkSessionStore(cwd),
						modelRuntime: m.runtime,
						settingsManager: SettingsManager.inMemory({
							...WITH_DEFAULT,
							retry: { enabled: false },
							compaction: { enabled: false },
						}),
						builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
					}),
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			m.requests.map((request) => request.model),
			[DEFAULT_ID],
		);
		assert.equal(m.requests[0]?.reasoning, "high");
	},
	REAL_SESSION_TIMEOUT_MS,
);

/** One `auto` stage through the public SDK `run()` and its default session adapter, with no `models` catalog. */
async function sdkAutoStage(input: {
	readonly settings: Settings;
	readonly fallbackModels?: readonly string[];
	/** The adapter's own model, as an SDK caller's `createAgentSessionAdapter({ model })` sets one. */
	readonly adapterSessionModel?: boolean;
	readonly failing?: readonly string[];
	readonly wrap?: (adapter: AgentSessionAdapter) => AgentSessionAdapter;
}) {
	const m = await models({ failing: input.failing });
	const cwd = tempDir("atomic-auto-default-sdk-adapter-");
	mkdirSync(join(cwd, "agent"), { recursive: true });
	const base = createAgentSessionAdapter({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionStore: await sdkSessionStore(cwd),
		modelRuntime: m.runtime,
		settingsManager: SettingsManager.inMemory({
			...input.settings,
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
		builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		...(input.adapterSessionModel ? { model: m.sessionModel, thinkingLevel: "low" as const } : {}),
	});
	const def = workflow({
		name: "sdk-auto-adapter-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const fallbackModels = input.fallbackModels === undefined ? {} : { fallbackModels: [...input.fallbackModels] };
			await ctx.stage("implement", { model: "auto", tools: [], ...fallbackModels }).prompt("Reply done.");
			return {};
		},
	});
	const result = await sdkRun(
		def,
		{},
		{
			cwd,
			journal: { memory: true },
			store: createStore(),
			adapters: { agentSession: input.wrap ? input.wrap(base) : base },
		},
	);
	return { result, requests: m.requests.map((request) => `${request.model}@${request.reasoning}`) };
}

test(
	"an SDK auto stage with fallbackModels starts on the configured default model, not its first fallback",
	async () => {
		const { result, requests } = await sdkAutoStage({ settings: WITH_DEFAULT, fallbackModels: [FALLBACK_ID] });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [`${DEFAULT_ID}@high`], "one stage turn on the default, no other request");
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"an SDK auto stage runs the configured default model even when its session adapter names a model of its own",
	async () => {
		const { result, requests } = await sdkAutoStage({ settings: WITH_DEFAULT, adapterSessionModel: true });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [`${DEFAULT_ID}@high`]);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"an SDK auto stage with no configured default starts on the adapter's session model before its fallbackModels",
	async () => {
		const { result, requests } = await sdkAutoStage({
			settings: {},
			adapterSessionModel: true,
			fallbackModels: [FALLBACK_ID],
		});
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [`${SESSION_ID}@low`]);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"an SDK auto stage with no configured default runs the adapter's session model",
	async () => {
		const { result, requests } = await sdkAutoStage({ settings: {}, adapterSessionModel: true });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [`${SESSION_ID}@low`]);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"an SDK auto stage whose default model fails moves on to its fallbackModels in order",
	async () => {
		const { result, requests } = await sdkAutoStage({
			settings: WITH_DEFAULT,
			fallbackModels: [FALLBACK_ID],
			failing: [DEFAULT_ID],
		});
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			requests.map((request) => request.split("@")[0]),
			[DEFAULT_ID, FALLBACK_ID],
		);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test(
	"an SDK auto stage keeps the default model through a session adapter that delegates to the default one",
	async () => {
		const { result, requests } = await sdkAutoStage({
			settings: WITH_DEFAULT,
			fallbackModels: [FALLBACK_ID],
			wrap: (base) => ({ ...base, create: (options, meta) => base.create(options, meta) }),
		});
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(requests, [`${DEFAULT_ID}@high`]);
	},
	REAL_SESSION_TIMEOUT_MS,
);

test("the admission and worker session adapters resolve auto through the adapter they wrap", async () => {
	const resolved = { model: DEFAULT_ID, thinkingLevel: "high" as const };
	const autoModel = vi.fn(async (_options: object, _needs?: object) => resolved);
	const base: AgentSessionAdapter = { create: async () => Promise.reject(new Error("not created")), autoModel };
	const wrappers = [
		admittedSessionAdapter(base, {} as Parameters<typeof admittedSessionAdapter>[1]),
		workerStageAdapter({ base } as Parameters<typeof workerStageAdapter>[0]),
	];
	for (const wrapped of wrappers)
		assert.deepEqual(await wrapped.autoModel?.({ cwd: "/stage" }, { imageInput: true }), resolved);
	// What the stage's model must support reaches the wrapped adapter too.
	assert.deepEqual(autoModel.mock.calls, [
		[{ cwd: "/stage" }, { imageInput: true }],
		[{ cwd: "/stage" }, { imageInput: true }],
	]);
});

test("the SDK session adapter resolves auto settings asynchronously when no settingsManager is supplied (#5377)", async () => {
	const m = await models();
	const root = tempDir("atomic-auto-default-sdk-async-settings-");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(WITH_DEFAULT));
	const createSyncSpy = vi.spyOn(SettingsManager, "create");
	const createAsyncSpy = vi.spyOn(SettingsManager, "createAsync");

	const suppliedAdapter = createAgentSessionAdapter({
		cwd,
		agentDir,
		modelRuntime: m.runtime,
		settingsManager: SettingsManager.inMemory(WITH_DEFAULT),
	});
	const fromSupplied = await suppliedAdapter.autoModel?.({});
	assert.ok(fromSupplied && typeof fromSupplied.model !== "string");
	assert.equal(`${fromSupplied.model.provider}/${fromSupplied.model.id}`, DEFAULT_ID);
	assert.equal(fromSupplied?.thinkingLevel, "high");
	assert.equal(createSyncSpy.mock.calls.length, 0);
	assert.equal(createAsyncSpy.mock.calls.length, 0);

	const diskAdapter = createAgentSessionAdapter({
		cwd,
		agentDir,
		modelRuntime: m.runtime,
	});
	const fromDisk = await diskAdapter.autoModel?.({});
	assert.ok(fromDisk && typeof fromDisk.model !== "string");
	assert.equal(`${fromDisk.model.provider}/${fromDisk.model.id}`, DEFAULT_ID);
	assert.equal(fromDisk?.thinkingLevel, "high");
	assert.equal(createSyncSpy.mock.calls.length, 0);
	assert.equal(createAsyncSpy.mock.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

test("saved modelRouting and router settings load without error and are dropped", () => {
	const root = tempDir("atomic-auto-default-settings-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			theme: "dark",
			routerModel: "x/y",
			modelRouting: { allowedProviders: ["anthropic"], excludedModels: ["*-mini"] },
		}),
	);
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ modelRouting: ["not-an-object"] }));
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	assert.deepEqual(manager.drainErrors(), []);
	const settings = manager.getSettings();
	assert.equal(Object.hasOwn(settings, "modelRouting"), false);
	assert.equal(Object.hasOwn(settings, "routerModel"), false);
	assert.equal(Object.hasOwn(manager.getProjectSettings(), "modelRouting"), false);
	assert.equal(settings.theme, "dark", "kept settings survive the migration");
	assert.equal(manager.getDecisionModel(), "x/y", "the legacy decision-model name still migrates");
});

test("a modelRouting setting is dropped with one warning that its restrictions no longer apply", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const root = tempDir("atomic-auto-default-settings-warning-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	const saved = { modelRouting: { excludedProviders: ["anthropic"] } };
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(saved));
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify(saved));
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	await manager.reload();
	SettingsManager.inMemory(saved as Settings).applyOverrides(saved as Settings);
	const warnings = routingWarnings(warn);
	assert.equal(warnings.length, 1, warnings.join("\n"));
	assert.match(warnings[0]!, /"modelRouting"/);
	assert.match(warnings[0]!, /no longer limit/);
	SettingsManager.inMemory({ theme: "dark" });
	assert.equal(routingWarnings(warn).length, 1, "settings without the key do not warn");
});

test("saved builtin agent overrides that still set modelConstraints warn once that it is ignored", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const file = join(tempDir("atomic-auto-default-override-"), "settings.json");
	writeFileSync(
		file,
		JSON.stringify({
			subagents: {
				agentOverrides: { worker: { model: "auto", modelConstraints: { excludedProviders: ["anthropic"] } } },
			},
		}),
	);
	const first = await readMergedSubagentSettings([file]);
	await readMergedSubagentSettings([file]);
	assert.equal(first.settings.overrides.worker?.model, "auto");
	assert.equal(Object.hasOwn(first.settings.overrides.worker!, "modelConstraints"), false);
	const warnings = routingWarnings(warn);
	assert.equal(warnings.length, 1, warnings.join("\n"));
	assert.match(warnings[0]!, /"modelConstraints"/);
});

test("while a UI owns the terminal, removed-option warnings go to it instead of being written over the screen", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const shown: string[] = [];
	const restore = setDeprecationWarningSink((message) => shown.push(message));
	try {
		SettingsManager.inMemory({ modelRouting: { excludedProviders: ["x"] } } as Settings);
		prepareSubagentArguments({ agent: "worker", task: "Task", taskNeeds: { work: "coding" } });
		const f = await stageFixture(WITH_DEFAULT);
		const def = workflow({
			name: "sink-warning",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const options = { model: "auto", parallelSlot: { index: 0, count: 1 } } as Parameters<typeof ctx.stage>[1];
				await ctx.stage("stage", options).prompt("Task");
				return {};
			},
		});
		assert.equal(
			(await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store })).status,
			"completed",
		);
	} finally {
		restore();
	}
	assert.deepEqual(routingWarnings(warn), [], "nothing is written to the terminal");
	assert.equal(shown.length, 3, shown.join("\n"));
	for (const option of ["modelRouting", "taskNeeds", "parallelSlot"])
		assert.ok(
			shown.some((message) => message.includes(`"${option}"`)),
			option,
		);
});

test("SDK settings and overrides carrying modelRouting load and drop it", async () => {
	for (const modelRouting of [{ allowedProviders: ["anthropic"] }, "invalid", ["not-an-object"]]) {
		const input = { defaultThinkingLevel: "high", modelRouting } as Settings;
		const manager = SettingsManager.inMemory(input);
		manager.applyOverrides({ modelRouting } as Settings);
		assert.deepEqual(manager.drainErrors(), [], JSON.stringify(modelRouting));
		assert.equal(Object.hasOwn(manager.getSettings(), "modelRouting"), false);
		assert.equal(manager.getDefaultThinkingLevel(), "high");
		await manager.reload();
		assert.equal(Object.hasOwn(manager.getSettings(), "modelRouting"), false);
	}
});
