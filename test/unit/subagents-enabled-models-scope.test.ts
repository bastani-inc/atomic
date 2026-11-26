import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	AuthStorage,
	type ExtensionContext,
	ModelRuntime,
	type Settings,
} from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentParamsLike,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { filterSpawnableModelCandidates } from "../../packages/subagents/src/runs/shared/model-candidate-filter.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";

/** Builds a real parent AgentSession and in-process child AgentSession with local stub providers. */
const REAL_CHILD_SESSION_TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeModel(provider: string, id: string): Model<Api> {
	const base = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
	return { ...base, provider, id, name: `${provider}/${id}` };
}

function makeWorker(cwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Test worker",
		source: "project",
		filePath: join(cwd, "worker.md"),
		systemPrompt: "You are a test worker.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		tools: ["read"],
		...overrides,
	};
}

function makeRegistry(available: Model<Api>[], all: Model<Api>[] = available) {
	const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
	return {
		getAvailable: () => available,
		getAll: () => all,
		find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: Model<Api>) => availableKeys.has(`${model.provider}/${model.id}`),
	};
}

function makeExecutor(options: {
	cwd: string;
	agents: AgentConfig[];
	settings?: Settings;
	ctx: ExtensionContext;
	runSync?: NonNullable<NonNullable<ExecutorDeps["runtime"]>["runSync"]>;
}) {
	const executor = createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
			getSettings: () => options.settings ?? {},
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
		tempArtifactsDir: join(options.cwd, "artifacts"),
		getSubagentSessionRoot: () => join(options.cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: options.agents }),
		...(options.runSync ? { runtime: { runSync: options.runSync } } : {}),
	});
	return (params: SubagentParamsLike) =>
		executor.execute("scope-test", params, new AbortController().signal, undefined, options.ctx);
}

function makeCtx(options: {
	cwd: string;
	available: Model<Api>[];
	currentModel?: Model<Api>;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: "off" | "low" | "medium" | "high" }>;
}): ExtensionContext {
	return {
		cwd: options.cwd,
		model: options.currentModel ?? options.available[0],
		thinkingLevel: "low",
		scopedModels: options.scopedModels ?? [],
		modelRegistry: makeRegistry(options.available),
		sessionManager: {
			getSessionFile: () => join(options.cwd, "session.jsonl"),
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
		isProjectTrusted: () => true,
		hasUI: false,
	} as unknown as ExtensionContext;
}

describe("subagent({ action: 'models' }) enabledModels / scopedModels filtering", () => {
	const anthropicSonnet = makeModel("anthropic", "claude-sonnet-4-5");
	const anthropicHaiku = makeModel("anthropic", "claude-haiku-4-5");
	const openaiGpt = makeModel("openai", "gpt-5");
	const googleGemini = makeModel("google", "gemini-2.5-pro");
	const catalog = [anthropicSonnet, anthropicHaiku, openaiGpt, googleGemini];

	async function queryModels(options: {
		enabledModels?: string[];
		scopedModels?: Array<{ model: Model<Api> }>;
	}): Promise<string[]> {
		const cwd = tempDir("atomic-subagent-models-scope-");
		const ctx = makeCtx({ cwd, available: catalog, scopedModels: options.scopedModels });
		const call = makeExecutor({
			cwd,
			agents: [makeWorker(cwd)],
			settings: options.enabledModels !== undefined ? { enabledModels: options.enabledModels } : {},
			ctx,
		});
		const result = await call({ action: "models" });
		assert.notEqual(result.isError, true);
		const structured = result.structuredContent as { action: string; models: Array<{ fullId: string }> };
		assert.equal(structured.action, "models");
		return structured.models.map((m) => m.fullId);
	}

	test("returns all available models when enabledModels and scopedModels are unset or empty", async () => {
		assert.deepEqual(await queryModels({}), [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-5",
			"google/gemini-2.5-pro",
		]);
		assert.deepEqual(await queryModels({ enabledModels: [], scopedModels: [] }), [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-5",
			"google/gemini-2.5-pro",
		]);
	});

	test("filters by provider glob (anthropic/*)", async () => {
		assert.deepEqual(await queryModels({ enabledModels: ["anthropic/*"] }), [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
		]);
	});

	test("filters by model glob (*sonnet*)", async () => {
		assert.deepEqual(await queryModels({ enabledModels: ["*sonnet*"] }), ["anthropic/claude-sonnet-4-5"]);
	});

	test("filters by exact provider/id", async () => {
		assert.deepEqual(await queryModels({ enabledModels: ["openai/gpt-5"] }), ["openai/gpt-5"]);
	});

	test("uses ctx.scopedModels when non-empty (e.g. from --models / /scoped-models)", async () => {
		assert.deepEqual(
			await queryModels({
				enabledModels: ["openai/gpt-5"],
				scopedModels: [{ model: googleGemini }],
			}),
			["google/gemini-2.5-pro"],
		);
	});

	test("returns empty list when enabledModels patterns match no available model", async () => {
		assert.deepEqual(await queryModels({ enabledModels: ["nonexistent/*"] }), []);
	});
});

describe("filterSpawnableModelCandidates enabledModels allowlist", () => {
	test("skips disallowed candidates with a clear reason naming enabledModels scope", () => {
		const filtered = filterSpawnableModelCandidates({
			candidates: ["openai/gpt-5", "anthropic/claude-sonnet-4-5:high", "google/gemini-2.5-pro", "claude-haiku-4-5"],
			availableModels: [
				{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
				{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5" },
				{ provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
				{ provider: "google", id: "gemini-2.5-pro", fullId: "google/gemini-2.5-pro" },
			],
			knownModelProviders: ["openai", "anthropic", "google"],
			currentModel: "openai/gpt-5",
			allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
		});

		assert.deepEqual(filtered.candidates, ["anthropic/claude-sonnet-4-5:high", "claude-haiku-4-5"]);
		assert.deepEqual(
			filtered.skippedAttempts.map((a) => a.model),
			["openai/gpt-5", "google/gemini-2.5-pro"],
		);
		for (const attempt of filtered.skippedAttempts) {
			assert.match(attempt.error ?? "", /enabledModels scope/);
		}
	});

	test("leaves all candidates untouched when allowedModels is undefined", () => {
		const filtered = filterSpawnableModelCandidates({
			candidates: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
			availableModels: [
				{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
				{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5" },
			],
			knownModelProviders: ["openai", "anthropic"],
		});

		assert.deepEqual(filtered.candidates, ["openai/gpt-5", "anthropic/claude-sonnet-4-5"]);
		assert.deepEqual(filtered.skippedAttempts, []);
	});
});

describe("subagent launch enforcement of enabledModels / scopedModels", () => {
	const anthropicSonnet = makeModel("anthropic", "claude-sonnet-4-5");
	const anthropicHaiku = makeModel("anthropic", "claude-haiku-4-5");
	const openaiGpt = makeModel("openai", "gpt-5");
	const available = [anthropicSonnet, anthropicHaiku, openaiGpt];
	const availableInfo = available.map((m) => ({ provider: m.provider, id: m.id, fullId: `${m.provider}/${m.id}` }));

	test("rejects an out-of-scope catalog model without misreporting it as unknown when it lacks auth", async () => {
		const cwd = tempDir("atomic-subagent-reject-explicit-");
		const worker = makeWorker(cwd);
		const result = await runSync(cwd, [worker], "worker", "Do work", {
			cwd,
			runId: "reject-explicit",
			modelOverride: "openai/gpt-5",
			availableModels: availableInfo.filter((model) => model.provider !== "openai"),
			knownModelProviders: ["anthropic", "openai"],
			allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
			resolveCandidateModel: createCandidateModelResolver(
				makeRegistry([anthropicSonnet, anthropicHaiku], available),
				"anthropic",
			),
			testSession: { output: "should never run" },
		});

		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /openai\/gpt-5/);
		assert.match(result.error ?? "", /enabledModels scope/);
		assert.deepEqual(
			result.modelAttempts?.map((a) => a.model),
			["openai/gpt-5"],
		);
	});

	test("suggests enabling the variant explicitly when its base is in scope (#6532)", async () => {
		const cwd = tempDir("atomic-subagent-variant-scope-");
		const base = makeModel("openai-1", "gpt-6.2-sol");
		const variant: Model<Api> = {
			...base,
			id: "gpt-6.2-sol-ultrafast",
			fastRoute: { baseModelId: base.id, upstreamModelId: base.id, serviceTier: "ultrafast" },
		};
		const catalog = [base, variant];
		const result = await runSync(cwd, [makeWorker(cwd)], "worker", "Do work", {
			cwd,
			runId: "reject-unlisted-tier",
			modelOverride: "openai-1/gpt-6.2-sol-ultrafast:high",
			allowedModels: ["openai-1/gpt-6.2-sol"],
			availableModels: catalog.map((m) => ({ provider: m.provider, id: m.id, fullId: `${m.provider}/${m.id}` })),
			resolveCandidateModel: createCandidateModelResolver(makeRegistry(catalog), "openai-1"),
			testSession: { output: "should never run" },
		});

		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /its base model openai-1\/gpt-6\.2-sol is in scope/);
		assert.match(result.error ?? "", /Add "openai-1\/gpt-6\.2-sol-ultrafast" to enabledModels/);
	});

	test("reports an unoffered variant as missing from the catalog, not outside the scope (#6532)", async () => {
		const cwd = tempDir("atomic-subagent-missing-variant-");
		const result = await runSync(cwd, [makeWorker(cwd)], "worker", "Do work", {
			cwd,
			runId: "reject-unknown-tier",
			modelOverride: "anthropic/claude-sonnet-4-5-ultrafast:high",
			allowedModels: ["anthropic/claude-sonnet-4-5"],
			availableModels: availableInfo,
			resolveCandidateModel: createCandidateModelResolver(makeRegistry(available), "anthropic"),
			testSession: { output: "should never run" },
		});

		assert.equal(result.status, "error");
		assert.match(result.error ?? "", /anthropic\/claude-sonnet-4-5-ultrafast:high: no such model in the catalog/);
		assert.doesNotMatch(result.error ?? "", /enabledModels scope/);
	});

	test("skips disallowed primary/fallback candidates and runs an allowed fallback candidate", async () => {
		const cwd = tempDir("atomic-subagent-skip-fallback-");
		const worker = makeWorker(cwd, {
			model: "openai/gpt-5",
			fallbackModels: ["anthropic/claude-haiku-4-5"],
		});
		const result = await runSync(cwd, [worker], "worker", "Do work", {
			cwd,
			runId: "skip-to-allowed-fallback",
			availableModels: availableInfo,
			knownModelProviders: ["anthropic", "openai"],
			allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
			resolveCandidateModel: createCandidateModelResolver(makeRegistry(available), "anthropic"),
			testSession: { output: "ran on allowed fallback" },
		});

		assert.equal(result.status, "ok");
		assert.equal(result.model, "anthropic/claude-haiku-4-5");
		assert.equal(result.finalOutput, "ran on allowed fallback");
	});

	test("single and parallel executor launches pass allowedModels and respect scope for auto models", async () => {
		const cwd = tempDir("atomic-subagent-exec-scope-");
		const worker = makeWorker(cwd, { model: "auto" });
		const captured: Array<{ modelOverride?: string; allowedModels?: readonly string[] }> = [];
		const ctx = makeCtx({
			cwd,
			available,
			currentModel: anthropicSonnet,
		});
		const call = makeExecutor({
			cwd,
			agents: [worker],
			settings: {
				defaultProvider: "openai",
				defaultModel: "gpt-5",
				enabledModels: ["anthropic/*"],
			},
			ctx,
			runSync: async (_cwd, _agents, agentName, task, options: RunSyncOptions) => {
				captured.push({ modelOverride: options.modelOverride, allowedModels: options.allowedModels });
				return {
					agent: agentName,
					task,
					status: "ok",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "ok",
				} satisfies SingleResult;
			},
		});

		const singleResult = await call({ agent: "worker", task: "Single auto task" });
		assert.notEqual(singleResult.isError, true);

		const parallelResult = await call({
			tasks: [
				{ agent: "worker", task: "Parallel auto task" },
				{ agent: "worker", task: "Parallel explicit task", model: "openai/gpt-5" },
			],
		});
		assert.notEqual(parallelResult.isError, true);

		assert.deepEqual(captured, [
			{
				modelOverride: "anthropic/claude-sonnet-4-5:low",
				allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
			},
			{
				modelOverride: "anthropic/claude-sonnet-4-5:low",
				allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
			},
			{
				modelOverride: "openai/gpt-5",
				allowedModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
			},
		]);
	});
});

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("in-process child session enabledModels / scopedModels enforcement", () => {
	test(
		"child session inherits parent scopedModels and skips disallowed mid-run fallback models",
		async () => {
			const cwd = tempDir("atomic-subagent-child-scope-");
			const authStorage = AuthStorage.inMemory({
				"scope-a": { type: "api_key", key: "test-a" },
				"scope-b": { type: "api_key", key: "test-b" },
			});
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: null,
			});

			const calledModels: string[] = [];
			const streamFor = (model: Model<Api>) => {
				const fullId = `${model.provider}/${model.id}`;
				calledModels.push(fullId);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (fullId === "scope-a/primary") {
						const errMsg: AssistantMessage = {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: "503 Service Unavailable: overloaded",
							timestamp: Date.now(),
						};
						stream.push({ type: "error", reason: "error", error: errMsg });
						stream.end();
						return;
					}
					const okMsg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: `answered by ${fullId}` }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message: okMsg });
					stream.end();
				});
				return stream;
			};

			const registerLocalProvider = (name: string, ids: string[]) => {
				modelRuntime.registerProvider(name, {
					baseUrl: `http://127.0.0.1:1/${name}`,
					apiKey: `test-${name}`,
					api: "openai-completions",
					models: ids.map((id) => ({
						id,
						name: `${name}/${id}`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					})),
					streamSimple: (model) => streamFor(model),
				});
			};
			registerLocalProvider("scope-a", ["primary", "backup"]);
			registerLocalProvider("scope-b", ["disallowed"]);

			const findModel = (provider: string, id: string) =>
				modelRuntime.getAvailableSnapshot().find((m) => m.provider === provider && m.id === id);
			const primary = findModel("scope-a", "primary")!;
			const backup = findModel("scope-a", "backup")!;
			const disallowed = findModel("scope-b", "disallowed")!;
			const settingsManager = SettingsManager.inMemory({
				fallbackModels: ["scope-b/disallowed", "scope-a/backup"],
				retry: { enabled: false },
			});
			const parentCreated = await createAgentSession({
				cwd,
				modelRuntime,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				model: primary,
				scopedModels: [{ model: primary }, { model: backup }],
				builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
			});
			cleanups.push(async () => {
				clearSubagentControls();
				await parentCreated.session.dispose();
			});

			const getChildSessionOptions = parentCreated.session.extensionRunner.createContext().getChildSessionOptions!;
			const inheritedPreview = getChildSessionOptions({});
			assert.deepEqual(
				inheritedPreview.scopedModels?.map((entry) => `${entry.model.provider}/${entry.model.id}`),
				["scope-a/primary", "scope-a/backup"],
			);
			assert.equal(inheritedPreview.isFallbackModelAllowed?.(backup, undefined), true);
			assert.equal(inheritedPreview.isFallbackModelAllowed?.(disallowed, undefined), false);

			const available = modelRuntime.getAvailableSnapshot();
			const availableInfo = available.map((m) => ({
				provider: m.provider,
				id: m.id,
				fullId: `${m.provider}/${m.id}`,
			}));
			const worker = makeWorker(cwd);
			const result = await runSingleInProcess(cwd, worker, "Say hello.", {
				cwd,
				runId: "child-mid-run-fallback-scope",
				getChildSessionOptions,
				availableModels: availableInfo,
				knownModelProviders: ["scope-a", "scope-b"],
				allowedModels: ["scope-a/primary", "scope-a/backup"],
				currentModel: "scope-a/primary",
				preferredModelProvider: "scope-a",
				resolveCandidateModel: createCandidateModelResolver(
					{
						getAvailable: () => [...modelRuntime.getAvailableSnapshot()],
						find: findModel,
						hasConfiguredAuth: (model) => modelRuntime.hasConfiguredAuth(model.provider),
					},
					"scope-a",
				),
			});

			assert.equal(result.status, "ok", result.error);
			assert.equal(result.model, "scope-a/backup");
			assert.deepEqual(calledModels, ["scope-a/primary", "scope-a/backup"]);
			assert.equal(calledModels.includes("scope-b/disallowed"), false);

			// Defense-in-depth: even without allowedModels on RunSyncOptions, parent scopedModels prevents
			// starting a child session on a disallowed model.
			const disallowedResult = await runSingleInProcess(cwd, worker, "Say hello.", {
				cwd,
				runId: "child-start-disallowed-scope",
				getChildSessionOptions,
				modelOverride: "scope-b/disallowed",
				availableModels: availableInfo,
				knownModelProviders: ["scope-a", "scope-b"],
				currentModel: "scope-a/primary",
				preferredModelProvider: "scope-a",
				resolveCandidateModel: createCandidateModelResolver(
					{
						getAvailable: () => [...modelRuntime.getAvailableSnapshot()],
						find: findModel,
						hasConfiguredAuth: (model) => modelRuntime.hasConfiguredAuth(model.provider),
					},
					"scope-a",
				),
			});
			assert.equal(disallowedResult.status, "error");
			assert.match(disallowedResult.error ?? "", /enabledModels scope/);
			assert.equal(calledModels.includes("scope-b/disallowed"), false);
		},
		REAL_CHILD_SESSION_TIMEOUT_MS,
	);
});
