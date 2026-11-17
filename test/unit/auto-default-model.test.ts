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
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";
import { applyAgentConfig } from "../../packages/subagents/src/agents/agent-management-helpers.js";
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
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { loadWorkflowModule } from "../../packages/workflows/src/extension/workflow-module-loader.js";
import { createAgentSessionAdapter, run as sdkRun } from "../../packages/workflows/src/sdk-surface.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

/** A real parent session and a real child or stage session against local providers. */
const REAL_SESSION_TIMEOUT_MS = 90_000;

const HOME = "home";
const LOCKED = "locked";
const DEFAULT_ID = `${HOME}/default-model`;
const SESSION_ID = `${HOME}/session-model`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
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

/** Two available models and one whose provider has no credentials; every request is recorded. */
async function models() {
	const base: Model<"anthropic-messages"> = { ...getModel("anthropic", "claude-sonnet-4-5")!, reasoning: true };
	const model = (provider: string, id: string): Model<"anthropic-messages"> => ({ ...base, provider, id, name: id });
	const defaultModel = model(HOME, "default-model");
	const sessionModel = model(HOME, "session-model");
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
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `done on ${fullId}` }],
			api: base.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
	runtime.registerProvider(HOME, {
		api: base.api,
		baseUrl: base.baseUrl,
		apiKey: "home-key",
		models: [defaultModel, sessionModel],
		streamSimple,
	});
	runtime.registerProvider(LOCKED, { api: base.api, baseUrl: base.baseUrl, models: [lockedModel], streamSimple });
	cleanups.push(() => {
		runtime.unregisterProvider(HOME);
		runtime.unregisterProvider(LOCKED);
	});
	return { runtime, registry: new ModelRegistry(runtime), defaultModel, sessionModel, lockedModel, requests };
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

test("agent files and agent config updates that still set taskNeeds or modelConstraints load with them ignored", () => {
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
	const { agents, diagnostics } = loadAgentsFromDirWithDiagnostics(dir, "user");
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
			builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
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

async function stageFixture(settings: Settings) {
	const m = await models();
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

test("prompt and complete adapters of an auto stage see the model it stands for, never auto", async () => {
	for (const method of ["prompt", "complete"] as const) {
		const f = await stageFixture(WITH_DEFAULT);
		let selected: string | undefined;
		const ctx = createStageContext(
			makeOpts({
				models: f.models,
				stageOptions: { model: "auto" },
				adapters:
					method === "prompt"
						? {
								prompt: {
									async prompt(_text, meta) {
										selected = String(meta?.stageOptions?.model);
										return "done";
									},
								},
							}
						: {
								complete: {
									async complete(_text, _options, meta) {
										selected = String(meta?.stageOptions?.model);
										return "done";
									},
								},
							},
			}),
		);
		assert.equal(await ctx[method]("Adapter task"), "done");
		assert.equal(selected, `${DEFAULT_ID}:high`);
		assert.deepEqual(f.requests, []);
		await ctx.__dispose();
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
	const result = await run(def, {}, { models: f.models, adapters: f.adapters, store: f.store });
	assert.equal(result.status, "completed", result.error);
	assert.equal(f.admissions.length, 4);
	for (const admission of f.admissions) assert.deepEqual(admission, { model: DEFAULT_ID, thinkingLevel: "high" });
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
						modelRuntime: m.runtime,
						settingsManager: SettingsManager.inMemory({
							...WITH_DEFAULT,
							retry: { enabled: false },
							compaction: { enabled: false },
						}),
						builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
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
