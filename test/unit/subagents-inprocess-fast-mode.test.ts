import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ENV_CODEX_FAST_MODE, getEnvNames, ModelRuntime } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import {
	runSync as runInProcessSync,
	runSingleInProcess,
} from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";

const fastModeEnvNames = getEnvNames(ENV_CODEX_FAST_MODE);
const agentDirEnvNames = getEnvNames(ENV_AGENT_DIR);
let previousFastModeEnv: Record<string, string | undefined> = {};
let previousAgentDirEnv: Record<string, string | undefined> = {};

const tempRoots: string[] = [];
const CODEX_MODEL = "openai/gpt-5.1-codex";
const ANTHROPIC_MODEL = "anthropic/claude-sonnet-4";
const COPILOT_MODEL = "github-copilot/gpt-5.6-sol";
const ALIAS_MODEL = "codex-alias/gpt-5.1-codex";
// Structural cost (AGENTS.md per-test timeout policy): the real-session test
// below (`testSession: false`) bootstraps a full builtin-package loader load
// for the in-process child. On Windows CI the child's cwd differs from the
// cached loader cwd, forcing a transformed re-import of the whole builtin
// extension graph (~15 ms/file x ~620 files, measured ~58 s cold). That cost
// is the loader's documented correctness cost, not a slow test nobody fixed.
const REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS = 180_000;

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "fast-mode fixture worker",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/fast-mode-worker.md",
	};
}

function aliasCodexModel() {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses" as const,
		provider: "codex-alias",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"] as ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function resolveAliasCandidate(candidateId: string) {
	if (candidateId === ALIAS_MODEL || candidateId.startsWith(`${ALIAS_MODEL}:`)) {
		return { model: aliasCodexModel() };
	}
	return undefined;
}

async function requestBody(init: RequestInit | undefined): Promise<Record<string, unknown> | undefined> {
	const text = await new Response(init?.body).text();
	return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

function completedOpenAIResponse(): Response {
	const message = {
		id: "msg_subagent_fast_mode",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
		phase: "final_answer",
	};
	const events = [
		{ type: "response.created", response: { id: "resp_subagent_fast_mode", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{
			type: "response.completed",
			response: {
				id: "resp_subagent_fast_mode",
				status: "completed",
				output: [message],
				usage: {
					input_tokens: 0,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 0,
					total_tokens: 0,
				},
			},
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function setupRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-fast-mode-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".atomic"), { recursive: true });
	writeFileSync(
		join(root, ".atomic", "settings.json"),
		JSON.stringify({
			defaultProvider: "openai",
			defaultModel: "gpt-5.1-codex",
			codexFastMode: { chat: false, workflow: true },
		}),
		"utf8",
	);
	return root;
}

function writeFastModeSettings(root: string, settings: { chat: boolean; workflow: boolean }): void {
	writeFileSync(
		join(root, ".atomic", "settings.json"),
		JSON.stringify({
			defaultProvider: "openai",
			defaultModel: "gpt-5.1-codex",
			codexFastMode: settings,
		}),
		"utf8",
	);
}

async function setupEntitledCopilot(root: string) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	for (const name of agentDirEnvNames) process.env[name] = agentDir;
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	await authStorage.modify("github-copilot", async () => ({
		type: "oauth",
		access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
		refresh: "test-refresh-token",
		expires: Number.MAX_SAFE_INTEGER,
		availableModelIds: ["gpt-5.6-sol"],
		fastModelIds: ["gpt-5.6-sol-fast"],
	}));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-api-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const resolveCandidateModel = createCandidateModelResolver(new ModelRegistry(modelRuntime), "github-copilot");
	assert.ok(resolveCandidateModel(COPILOT_MODEL), "Copilot fixture model should resolve through the real registry");
	return resolveCandidateModel;
}
beforeEach(() => {
	previousFastModeEnv = Object.fromEntries(fastModeEnvNames.map((name) => [name, process.env[name]]));
	previousAgentDirEnv = Object.fromEntries(agentDirEnvNames.map((name) => [name, process.env[name]]));
	for (const name of fastModeEnvNames) delete process.env[name];
	for (const name of agentDirEnvNames) delete process.env[name];
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearSubagentControls();
	for (const name of fastModeEnvNames) {
		if (previousFastModeEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousFastModeEnv[name];
	}
	for (const name of agentDirEnvNames) {
		if (previousAgentDirEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousAgentDirEnv[name];
	}
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("in-process child results use the workflow fast-mode setting for workflow stages", async () => {
	const root = setupRoot();
	const workflowResult = await runSingleInProcess(root, agent(), "workflow task", {
		cwd: root,
		runId: "workflow-fast-mode",
		modelOverride: CODEX_MODEL,
		workflowStageSubagentGuard: false,
		workflowSessionMetadata: {
			runId: "workflow-run",
			stageId: "stage-1",
			stageName: "Stage 1",
		},
		testSession: { output: "workflow result" },
	});
	const chatResult = await runSingleInProcess(root, agent(), "chat task", {
		cwd: root,
		runId: "chat-fast-mode",
		modelOverride: CODEX_MODEL,
		testSession: { output: "chat result" },
	});

	assert.equal(workflowResult.model, CODEX_MODEL);
	assert.equal(workflowResult.fastMode, true);
	assert.equal(chatResult.model, CODEX_MODEL);
	assert.equal(chatResult.fastMode, undefined);
});

test("foreground launch updates carry step metadata before the prompt settles", async () => {
	const root = setupRoot();
	const gate = Promise.withResolvers<void>();
	const updates: Array<{ details?: { progress?: Array<{ model?: string; thinking?: string; fastMode?: boolean }> } }> =
		[];
	try {
		const running = runSingleInProcess(root, { ...agent(), thinking: "high" }, "launch task", {
			cwd: root,
			runId: "foreground-launch-metadata",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
			testSession: { output: "launch result", promptGate: gate.promise },
			onUpdate: (update) => updates.push(update),
		});
		const progress = updates[0]?.details?.progress?.[0];
		assert.equal(progress?.model, CODEX_MODEL);
		assert.equal(progress?.thinking, "high");
		assert.equal(progress?.fastMode, true);
		gate.resolve();
		assert.equal((await running).status, "ok");
	} finally {
		gate.resolve();
	}
});

test("foreground results and live progress follow the effective fallback model's fast-mode scope", async () => {
	const root = setupRoot();
	const fallbackModel = "anthropic/claude-sonnet-4";
	const liveResults: Array<{ model?: string; thinking?: string; fastMode?: boolean }> = [];
	const fallbackAgent: AgentConfig = {
		...agent(),
		thinking: "low",
		fallbackModels: [`${fallbackModel}:high`],
	};

	const result = await runSingleInProcess(root, fallbackAgent, "fallback task", {
		cwd: root,
		runId: "foreground-fallback-metadata",
		modelOverride: CODEX_MODEL,
		workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
		testSession: { output: "fallback result", fallbackModel, fallbackThinkingLevel: "high" },
		onUpdate: (update) => {
			const liveResult = update.details?.results[0];
			if (liveResult) liveResults.push(liveResult);
		},
	});

	assert.equal(result.model, fallbackModel);
	assert.equal(result.thinking, "high");
	assert.equal(result.fastMode, undefined);
	assert.ok(
		liveResults.some(
			(liveResult) =>
				liveResult.model === fallbackModel && liveResult.thinking === "high" && liveResult.fastMode === undefined,
		),
		"live progress should use the fallback model's effective thinking and fast-mode scope",
	);
});

test("fallback transitions clear and gain entitled Copilot fast markers independently", async () => {
	const root = setupRoot();
	writeFastModeSettings(root, { chat: true, workflow: false });
	const resolveCandidateModel = await setupEntitledCopilot(root);
	const liveResults: Array<{ model?: string; fastMode?: boolean }> = [];
	const onUpdate = (update: { details?: { results: Array<{ model?: string; fastMode?: boolean }> } }) => {
		const liveResult = update.details?.results[0];
		if (liveResult) liveResults.push(liveResult);
	};

	const cleared = await runSingleInProcess(
		root,
		{ ...agent(), fallbackModels: [ANTHROPIC_MODEL] },
		"fall back away from Copilot",
		{
			cwd: root,
			runId: "copilot-fallback-clear",
			modelOverride: COPILOT_MODEL,
			resolveCandidateModel,
			testSession: { output: "cleared", fallbackModel: ANTHROPIC_MODEL },
			onUpdate,
		},
	);
	assert.equal(cleared.model, ANTHROPIC_MODEL);
	assert.equal(cleared.fastMode, undefined);
	assert.ok(liveResults.some((result) => result.model === ANTHROPIC_MODEL && result.fastMode === undefined));

	liveResults.length = 0;
	const gained = await runSingleInProcess(
		root,
		{ ...agent(), fallbackModels: [COPILOT_MODEL] },
		"fall back onto Copilot",
		{
			cwd: root,
			runId: "copilot-fallback-gain",
			modelOverride: ANTHROPIC_MODEL,
			resolveCandidateModel,
			testSession: { output: "gained", fallbackModel: COPILOT_MODEL },
			onUpdate,
		},
	);
	assert.equal(gained.model, COPILOT_MODEL);
	assert.equal(gained.fastMode, true);
	assert.ok(liveResults.some((result) => result.model === COPILOT_MODEL && result.fastMode === true));
});

test("Codex-transport alias children keep resolved API fast markers through fallback", async () => {
	const root = setupRoot();
	writeFastModeSettings(root, { chat: true, workflow: false });
	const liveResults: Array<{ model?: string; fastMode?: boolean }> = [];
	const onUpdate = (update: { details?: { results: Array<{ model?: string; fastMode?: boolean }> } }) => {
		const liveResult = update.details?.results[0];
		if (liveResult) liveResults.push(liveResult);
	};

	const selected = await runSingleInProcess(root, agent(), "alias selected", {
		cwd: root,
		runId: "alias-selected-fast-mode",
		modelOverride: ALIAS_MODEL,
		resolveCandidateModel: resolveAliasCandidate,
		testSession: { output: "alias selected" },
		onUpdate,
	});
	assert.equal(selected.model, ALIAS_MODEL);
	assert.equal(selected.fastMode, true);
	assert.ok(liveResults.some((result) => result.model === ALIAS_MODEL && result.fastMode === true));

	liveResults.length = 0;
	const gained = await runSingleInProcess(
		root,
		{ ...agent(), fallbackModels: [ALIAS_MODEL] },
		"fall back onto alias",
		{
			cwd: root,
			runId: "alias-fallback-gain",
			modelOverride: ANTHROPIC_MODEL,
			resolveCandidateModel: resolveAliasCandidate,
			testSession: { output: "gained", fallbackModel: ALIAS_MODEL },
			onUpdate,
		},
	);
	assert.equal(gained.model, ALIAS_MODEL);
	assert.equal(gained.fastMode, true);
	assert.ok(liveResults.some((result) => result.model === ALIAS_MODEL && result.fastMode === true));

	liveResults.length = 0;
	const cleared = await runSingleInProcess(
		root,
		{ ...agent(), fallbackModels: [ANTHROPIC_MODEL] },
		"fall back away from alias",
		{
			cwd: root,
			runId: "alias-fallback-clear",
			modelOverride: ALIAS_MODEL,
			resolveCandidateModel: resolveAliasCandidate,
			testSession: { output: "cleared", fallbackModel: ANTHROPIC_MODEL },
			onUpdate,
		},
	);
	assert.equal(cleared.model, ANTHROPIC_MODEL);
	assert.equal(cleared.fastMode, undefined);
	assert.ok(liveResults.some((result) => result.model === ANTHROPIC_MODEL && result.fastMode === undefined));
});

test("foreground parallel launches retain independent eligible and ineligible fast markers", async () => {
	const root = setupRoot();
	writeFastModeSettings(root, { chat: true, workflow: false });
	const resolveCandidateModel = await setupEntitledCopilot(root);
	const copilotAgent = { ...agent(), name: "copilot-worker" };
	const anthropicAgent = { ...agent(), name: "anthropic-worker" };
	const results = await runForegroundParallelTasks({
		tasks: [
			{ agent: copilotAgent.name, task: "Copilot task" },
			{ agent: anthropicAgent.name, task: "Anthropic task" },
		],
		taskTexts: ["Copilot task", "Anthropic task"],
		agents: [copilotAgent, anthropicAgent],
		agentConfigs: [copilotAgent, anthropicAgent],
		ctx: { cwd: root } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
		intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
		signal: new AbortController().signal,
		runId: "parallel-copilot-fast-mode",
		sessionDirForIndex: (index) => join(root, "sessions", String(index)),
		sessionFileForIndex: () => undefined,
		shareEnabled: false,
		artifactConfig: {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 0,
		},
		artifactsDir: root,
		paramsCwd: root,
		availableModels: [],
		knownModelProviders: [],
		resolveCandidateModel,
		modelOverrides: [COPILOT_MODEL, ANTHROPIC_MODEL],
		behaviors: [
			{ output: false, outputMode: "inline", reads: false, progress: false, skills: false },
			{ output: false, outputMode: "inline", reads: false, progress: false, skills: false },
		],
		firstProgressIndex: -1,
		controlConfig: {
			enabled: false,
			needsAttentionAfterMs: 1,
			activeNoticeAfterMs: 1,
			failedToolAttemptsBeforeAttention: 1,
			notifyOn: [],
			notifyChannels: [],
		},
		concurrencyLimit: 2,
		liveResults: [],
		liveProgress: [],
		runtime: {
			runSync: (runtimeCwd, agents, agentName, task, options) =>
				runInProcessSync(runtimeCwd, agents, agentName, task, {
					...options,
					testSession: { output: `${agentName} done` },
				}),
		},
	});

	assert.deepEqual(
		results.map((result) => ({ model: result.model, fastMode: result.fastMode })),
		[
			{ model: COPILOT_MODEL, fastMode: true },
			{ model: ANTHROPIC_MODEL, fastMode: undefined },
		],
	);
});

test("in-process attempt metadata uses the entitled Copilot fast marker by default", async () => {
	const root = setupRoot();
	writeFastModeSettings(root, { chat: true, workflow: false });
	const resolveCandidateModel = await setupEntitledCopilot(root);
	const resolved = resolveCandidateModel(COPILOT_MODEL);
	assert.ok(resolved);
	const gate = Promise.withResolvers<void>();
	try {
		const parent = { path: "copilot-attempt-parent", depth: 0 };
		const control = new SubagentControlRuntime(parent, join(root, "sessions"));
		control.registerAgents([agent()]);
		const admitted = control.admitChildSession(
			{
				taskName: "worker",
				task: "capture default attempt metadata",
				agent: agent(),
				cwd: root,
				model: resolved.model,
				testSession: { promptGate: gate.promise },
			},
			parent,
		).admitted;
		assert.ok(admitted);
		const neverAbort = new AbortController().signal;
		const running = control.startAttempt(
			admitted,
			{ model: resolved.model, modelId: COPILOT_MODEL },
			{ abort: neverAbort, interrupt: neverAbort },
		);

		assert.equal(running.currentFastMode, true);
		assert.equal(control.getChildMetadata(admitted.identity.path)?.fastMode, true);
		gate.resolve();
		assert.equal((await running.promise).status, "ok");
	} finally {
		gate.resolve();
	}
});

test(
	"chat and workflow Copilot children align real fast dispatch with live and completed markers",
	async () => {
		const root = setupRoot();
		writeFastModeSettings(root, { chat: true, workflow: false });
		const resolveCandidateModel = await setupEntitledCopilot(root);
		const payloads: Record<string, unknown>[] = [];
		const liveResults: Array<{ model?: string; thinking?: string; fastMode?: boolean }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const payload = await requestBody(init);
				if (payload) payloads.push(payload);
				return completedOpenAIResponse();
			}),
		);

		const enabled = await runSingleInProcess(root, agent(), "Copilot fast request", {
			cwd: root,
			runId: "chat-copilot-real-request-enabled",
			modelOverride: `${COPILOT_MODEL}:xhigh`,
			resolveCandidateModel,
			testSession: false,
			onUpdate: (update) => {
				const liveResult = update.details?.results[0];
				if (liveResult) liveResults.push(liveResult);
			},
		});

		assert.equal(enabled.status, "ok");
		assert.equal(enabled.model, COPILOT_MODEL);
		assert.equal(enabled.thinking, "xhigh");
		assert.equal(enabled.fastMode, true);
		assert.equal(enabled.progress?.fastMode, true);
		assert.ok(liveResults.some((result) => result.model === COPILOT_MODEL && result.fastMode === true));
		assert.ok(payloads.length > 0);
		for (const payload of payloads) {
			assert.equal(payload.model, "gpt-5.6-sol-fast");
			assert.equal("service_tier" in payload, false);
			assert.equal("speed" in payload, false);
		}

		payloads.length = 0;
		liveResults.length = 0;
		writeFastModeSettings(root, { chat: false, workflow: true });
		const disabled = await runSingleInProcess(root, agent(), "Copilot normal request", {
			cwd: root,
			runId: "chat-copilot-real-request-disabled",
			modelOverride: COPILOT_MODEL,
			resolveCandidateModel,
			testSession: false,
			onUpdate: (update) => {
				const liveResult = update.details?.results[0];
				if (liveResult) liveResults.push(liveResult);
			},
		});

		assert.equal(disabled.status, "ok");
		assert.equal(disabled.model, COPILOT_MODEL);
		assert.equal(disabled.fastMode, undefined);
		assert.equal(disabled.progress?.fastMode, undefined);
		assert.equal(
			liveResults.some((result) => result.fastMode === true),
			false,
		);
		assert.ok(payloads.length > 0);
		for (const payload of payloads) {
			assert.equal(payload.model, "gpt-5.6-sol");
			assert.equal("service_tier" in payload, false);
			assert.equal("speed" in payload, false);
		}

		payloads.length = 0;
		liveResults.length = 0;
		const workflow = await runSingleInProcess(root, agent(), "workflow Copilot fast request", {
			cwd: root,
			runId: "workflow-copilot-real-request-enabled",
			modelOverride: COPILOT_MODEL,
			resolveCandidateModel,
			workflowStageSubagentGuard: false,
			workflowSessionMetadata: { runId: "workflow-run", stageId: "nested-stage", stageName: "Nested stage" },
			testSession: false,
			onUpdate: (update) => {
				const liveResult = update.details?.results[0];
				if (liveResult) liveResults.push(liveResult);
			},
		});

		assert.equal(workflow.status, "ok");
		assert.equal(workflow.model, COPILOT_MODEL);
		assert.equal(workflow.fastMode, true);
		assert.equal(workflow.progress?.fastMode, true);
		assert.ok(liveResults.some((result) => result.model === COPILOT_MODEL && result.fastMode === true));
		assert.ok(payloads.length > 0);
		for (const payload of payloads) {
			assert.equal(payload.model, "gpt-5.6-sol-fast");
			assert.equal("service_tier" in payload, false);
			assert.equal("speed" in payload, false);
		}
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);

test(
	"model-less children inherit the parent Copilot model, thinking, fast dispatch, and marker",
	async () => {
		const root = setupRoot();
		writeFastModeSettings(root, { chat: true, workflow: false });
		const resolveCandidateModel = await setupEntitledCopilot(root);
		const payloads: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const payload = await requestBody(init);
				if (payload) payloads.push(payload);
				return completedOpenAIResponse();
			}),
		);

		const result = await runSingleInProcess(root, agent(), "inherit Copilot parent", {
			cwd: root,
			runId: "chat-copilot-inherited-parent",
			currentModel: COPILOT_MODEL,
			currentThinkingLevel: "xhigh",
			resolveCandidateModel,
			testSession: false,
		});

		assert.equal(result.status, "ok");
		assert.equal(result.model, COPILOT_MODEL);
		assert.equal(result.thinking, "xhigh");
		assert.equal(result.fastMode, true);
		assert.equal(result.progress?.fastMode, true);
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.model, "gpt-5.6-sol-fast");
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);

test(
	"stage-launched in-process children carry workflow priority tier to the provider request",
	async () => {
		const root = setupRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }),
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		const payloads: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const payload = await requestBody(init);
				if (payload) payloads.push(payload);
				return completedOpenAIResponse();
			}),
		);
		const workflowSessionMetadata = { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" };
		const enabled = await runSingleInProcess(root, agent(), "priority request", {
			cwd: root,
			runId: "workflow-real-request-enabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(enabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, "priority");
		payloads.length = 0;

		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "gpt-5.1-codex",
				codexFastMode: { chat: false, workflow: false },
			}),
			"utf8",
		);
		const disabled = await runSingleInProcess(root, agent(), "ordinary request", {
			cwd: root,
			runId: "workflow-real-request-disabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(disabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, undefined);
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);

test(
	"real child results report the session's clamped thinking level",
	async () => {
		const root = setupRoot();
		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "non-reasoning-fixture",
				codexFastMode: { chat: false, workflow: true },
			}),
			"utf8",
		);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }),
			"utf8",
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					openai: {
						api: "openai-responses",
						baseUrl: "https://api.openai.example/v1",
						models: [
							{
								id: "non-reasoning-fixture",
								name: "Non-reasoning fixture",
								reasoning: false,
								input: ["text"],
								contextWindow: 128_000,
								maxTokens: 4_096,
							},
						],
					},
				},
			}),
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedOpenAIResponse()),
		);

		const result = await runSingleInProcess(root, { ...agent(), thinking: "xhigh" }, "clamp thinking", {
			cwd: root,
			runId: "real-thinking-clamp",
			modelOverride: "openai/non-reasoning-fixture",
			testSession: false,
		});

		assert.equal(result.status, "ok");
		assert.equal(result.model, "openai/non-reasoning-fixture");
		assert.equal(result.thinking, "off");
		assert.equal(result.progress?.thinking, "off");
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);
