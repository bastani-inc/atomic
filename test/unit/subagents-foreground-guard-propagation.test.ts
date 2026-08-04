import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "../../packages/subagents/src/shared/types.js";

interface MinimalRunSyncOptions {
	maxSubagentDepth?: number;
	workflowStageSubagentGuard?: boolean;
}

interface MinimalAsyncSingleParams {
	maxSubagentDepth?: number;
	workflowStageSubagentGuard?: boolean;
}

interface CapturedRunSyncCall {
	agentName: string;
	options: MinimalRunSyncOptions;
}

interface CapturedAsyncSingleCall {
	id: string;
	params: MinimalAsyncSingleParams;
}

interface MinimalAgentConfig {
	name: string;
	description: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
	maxSubagentDepth?: number;
}

type ExecutorForTest = ReturnType<typeof createSubagentExecutor>;
type ExecutorDepsForTest = Parameters<typeof createSubagentExecutor>[0];
type ExecutorContextForTest = Parameters<ExecutorForTest["execute"]>[4];
type ExecutorResultForTest = Awaited<ReturnType<ExecutorForTest["execute"]>>;

const runSyncCalls: CapturedRunSyncCall[] = [];
const asyncSingleCalls: CapturedAsyncSingleCall[] = [];
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

const runSyncMock = vi.fn(
	async (
		_cwd: string,
		_agents: MinimalAgentConfig[],
		agentName: string,
		task: string,
		options: MinimalRunSyncOptions,
	) => {
		runSyncCalls.push({ agentName, options });
		return {
			agent: agentName,
			task,
			status: "ok" as const,
			exitCode: 0,
			messages: [],
			usage: emptyUsage,
			finalOutput: `${agentName} output`,
		};
	},
);

const executeAsyncSingleMock = vi.fn((id: string, params: MinimalAsyncSingleParams) => {
	asyncSingleCalls.push({ id, params });
	return {
		content: [{ type: "text" as const, text: "Launching in background..." }],
		details: { mode: "single" as const, results: [] },
	};
});

function makeAgent(name: string, maxSubagentDepth?: number): MinimalAgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: `/tmp/${name}.md`,
		...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
	};
}

function makeState() {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeUiContext(uiResult?: unknown): ExecutorContextForTest["ui"] {
	return { custom: async <T>() => uiResult as T } as unknown as ExecutorContextForTest["ui"];
}

function makeModelRegistry(): ExecutorContextForTest["modelRegistry"] {
	return { getAvailable: () => [] } as unknown as ExecutorContextForTest["modelRegistry"];
}

function makeWorkflowStageContext(cwd: string, uiResult?: unknown): ExecutorContextForTest {
	return {
		cwd,
		mode: "tui",
		hasUI: uiResult !== undefined,
		ui: makeUiContext(uiResult),
		model: undefined,
		scopedModels: [],
		modelRegistry: makeModelRegistry(),
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		} as ExecutorContextForTest["sessionManager"],
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: "workflow-run-1",
			workflowStageId: "stage-1",
			workflowStageName: "Stage 1",
			constraints: { disableWorkflowTool: true, maxSubagentDepth: 2 },
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} satisfies ExecutorContextForTest;
}

function makeExecutor(agents: MinimalAgentConfig[]) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-subagent-guard-"));
	const deps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session-name",
		} as unknown as ExecutorDepsForTest["pi"],
		state: makeState(),
		config: { maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault: false,
		tempArtifactsDir: path.join(tempRoot, "artifacts"),
		getSubagentSessionRoot: () => path.join(tempRoot, "sessions"),
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents }),
		runtime: {
			runSync: runSyncMock,
			executeAsyncSingle: executeAsyncSingleMock,
			isAsyncAvailable: () => true,
		},
	} satisfies ExecutorDepsForTest;
	return createSubagentExecutor(deps);
}

function clearSubagentGuardEnv(): void {
	delete process.env.ATOMIC_SUBAGENT_DEPTH;
	delete process.env.ATOMIC_SUBAGENT_MAX_DEPTH;
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
}

function resetCapturedCalls(): void {
	runSyncCalls.length = 0;
	asyncSingleCalls.length = 0;
	runSyncMock.mockClear();
	executeAsyncSingleMock.mockClear();
}

function assertNoErrorFlag(result: ExecutorResultForTest): void {
	assert.equal(result.isError, undefined);
}

function assertGuardedRunSyncCalls(expectedAgentNames: string[]): void {
	assert.deepEqual(
		runSyncCalls.map((call) => call.agentName),
		expectedAgentNames,
	);
	for (const call of runSyncCalls) {
		assert.equal(call.options.maxSubagentDepth, 2);
		assert.equal(call.options.workflowStageSubagentGuard, true);
	}
}

beforeEach(() => {
	resetCapturedCalls();
	clearSubagentGuardEnv();
});

afterAll(clearSubagentGuardEnv);

describe("foreground workflow-stage subagent guard propagation", () => {
	test("passes workflow-stage guard to sequential and parallel chain children", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-chain-guard-"));
		const executor = makeExecutor([makeAgent("alpha"), makeAgent("beta"), makeAgent("gamma")]);
		const result = await executor.execute(
			"subagent",
			{
				chain: [
					{ agent: "alpha", task: "first" },
					{
						parallel: [
							{ agent: "beta", task: "second" },
							{ agent: "gamma", task: "third" },
						],
					},
				],
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(result);
		assertGuardedRunSyncCalls(["alpha", "beta", "gamma"]);
	});

	test("passes workflow-stage guard to foreground parallel children", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-parallel-guard-"));
		const executor = makeExecutor([makeAgent("alpha"), makeAgent("beta")]);
		const result = await executor.execute(
			"subagent",
			{
				tasks: [
					{ agent: "alpha", task: "first" },
					{ agent: "beta", task: "second" },
				],
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(result);
		assertGuardedRunSyncCalls(["alpha", "beta"]);
	});

	test("passes workflow-stage guard to async parallel children on the foreground executor", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-parallel-async-guard-"));
		const executor = makeExecutor([makeAgent("alpha"), makeAgent("beta")]);
		const result = await executor.execute(
			"subagent",
			{
				tasks: [
					{ agent: "alpha", task: "first" },
					{ agent: "beta", task: "second" },
				],
				async: true,
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assertNoErrorFlag(result);
		assert.equal(result.details.results[0]?.status, "continued");
		assertGuardedRunSyncCalls(["alpha", "beta"]);
	});

	test("passes workflow-stage guard to an async single child", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-single-async-guard-"));
		const executor = makeExecutor([makeAgent("alpha")]);
		const result = await executor.execute(
			"subagent",
			{ agent: "alpha", task: "single task", async: true },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(result);
		assert.equal(runSyncCalls.length, 0);
		assert.equal(asyncSingleCalls.length, 1);
		assert.equal(asyncSingleCalls[0]!.params.maxSubagentDepth, 2);
		assert.equal(asyncSingleCalls[0]!.params.workflowStageSubagentGuard, true);
	});
});
