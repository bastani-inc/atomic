import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";
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
	type Model,
} from "@bastani/atomic-ai/compat";
import { Compile } from "typebox/compile";
import { afterEach, test, vi } from "vitest";

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

/** A real parent session and a real child or stage session against local providers. */
const REAL_SESSION_TIMEOUT_MS = 90_000;

const HOME = "home";
const LOCKED = "locked";
const DEFAULT_ID = `${HOME}/default-model`;
const SESSION_ID = `${HOME}/session-model`;

/** A failure the stage's fallback walk moves past. */
const UNAVAILABLE = "503 Service Unavailable: the model is overloaded";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	clearDeprecationWarningsForTests();
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
	const base: Model<"anthropic-messages"> = { ...getFixtureModel("anthropic", "claude-sonnet-4-5")!, reasoning: true };
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
	} finally {
		restore();
	}
	assert.deepEqual(routingWarnings(warn), [], "nothing is written to the terminal");
	assert.equal(shown.length, 2, shown.join("\n"));
	for (const option of ["modelRouting", "taskNeeds"])
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
