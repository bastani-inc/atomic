import { afterAll, beforeEach, describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV, type SubagentToolResult } from "../../packages/subagents/src/shared/types.js";

interface MinimalRunSyncOptions {
	maxSubagentDepth?: number;
	workflowStageSubagentGuard?: boolean;
	onUpdate?: (update: SubagentToolResult) => void;
}

interface MinimalAsyncChainParams {
	resultMode?: "chain" | "parallel";
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

interface CapturedAsyncChainCall {
	id: string;
	params: MinimalAsyncChainParams;
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
const asyncChainCalls: CapturedAsyncChainCall[] = [];
const asyncSingleCalls: CapturedAsyncSingleCall[] = [];

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeProgressUpdate(agent: string, task: string): SubagentToolResult {
	const progress = {
		index: 0,
		agent,
		status: "running" as const,
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 1,
	};
	return {
		content: [{ type: "text", text: "running" }],
		details: {
			mode: "single",
			results: [],
			progress: [progress],
		},
	};
}

const runSyncMock = mock(async (
	_cwd: string,
	_agents: MinimalAgentConfig[],
	agentName: string,
	task: string,
	options: MinimalRunSyncOptions,
) => {
	runSyncCalls.push({ agentName, options });
	if (task.includes("throw stale parent")) {
		options.onUpdate?.(makeProgressUpdate(agentName, task));
		options.onUpdate?.(makeProgressUpdate(agentName, task));
	}
	if (task === "late update") {
		setTimeout(() => options.onUpdate?.(makeProgressUpdate(agentName, task)), 0);
	}
	return {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage,
		finalOutput: `${agentName} output`,
	};
});

const executeAsyncChainMock = mock((id: string, params: MinimalAsyncChainParams) => {
	asyncChainCalls.push({ id, params });
	return {
		content: [{ type: "text" as const, text: "Launching in background..." }],
		details: { mode: params.resultMode ?? "chain", results: [] },
	};
});

const executeAsyncSingleMock = mock((id: string, params: MinimalAsyncSingleParams) => {
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function makeUiContext(uiResult?: unknown): ExecutorContextForTest["ui"] {
	const ui: Pick<ExecutorContextForTest["ui"], "custom"> = {
		custom: async <T>() => uiResult as T,
	};
	return ui as ExecutorContextForTest["ui"];
}

function makeModelRegistry(): ExecutorContextForTest["modelRegistry"] {
	const modelRegistry: Pick<ExecutorContextForTest["modelRegistry"], "getAvailable"> = {
		getAvailable: () => [],
	};
	return modelRegistry as ExecutorContextForTest["modelRegistry"];
}

function makeWorkflowStageContext(cwd: string, uiResult?: unknown): ExecutorContextForTest {
	return {
		cwd,
		hasUI: uiResult !== undefined,
		ui: makeUiContext(uiResult),
		model: undefined,
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
			constraints: { disableWorkflowTool: true, maxSubagentDepth: 1 },
		},
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} satisfies ExecutorContextForTest;
}

function makePi(): ExecutorDepsForTest["pi"] {
	const pi: Pick<ExecutorDepsForTest["pi"], "events" | "getSessionName"> = {
		events: {
			on: (_channel: string, _handler: (data: unknown) => void) => () => {},
			emit: (_channel: string, _data: unknown) => {},
		},
		getSessionName: () => "parent-session-name",
	};
	return pi as ExecutorDepsForTest["pi"];
}

function makeExecutor(_cwd: string, agents: MinimalAgentConfig[]) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-subagent-guard-"));
	const deps = {
		pi: makePi(),
		state: makeState(),
		config: { maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 8 } },
		asyncByDefault: false,
		tempArtifactsDir: path.join(tempRoot, "artifacts"),
		getSubagentSessionRoot: () => path.join(tempRoot, "sessions"),
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents }),
		runtime: {
			runSync: runSyncMock,
			executeAsyncChain: executeAsyncChainMock,
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
	asyncChainCalls.length = 0;
	asyncSingleCalls.length = 0;
	runSyncMock.mockClear();
	executeAsyncChainMock.mockClear();
	executeAsyncSingleMock.mockClear();
}

function assertNoErrorFlag(result: ExecutorResultForTest): void {
	assert.equal(result.isError, undefined);
}

function assertGuardedRunSyncCalls(expectedAgentNames: string[]): void {
	assert.deepEqual(runSyncCalls.map((call) => call.agentName), expectedAgentNames);
	for (const call of runSyncCalls) {
		assert.equal(call.options.maxSubagentDepth, 1);
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
		const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("gamma")];
		const executor = makeExecutor(cwd, agents);

		const result = await executor.execute(
			"subagent",
			{
				chain: [
					{ agent: "alpha", task: "first" },
					{ parallel: [{ agent: "beta", task: "second" }, { agent: "gamma", task: "third" }] },
				],
				clarify: false,
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
		const agents = [makeAgent("alpha"), makeAgent("beta")];
		const executor = makeExecutor(cwd, agents);

		const result = await executor.execute(
			"subagent",
			{
				tasks: [{ agent: "alpha", task: "first" }, { agent: "beta", task: "second" }],
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(result);
		assertGuardedRunSyncCalls(["alpha", "beta"]);
	});

	test("passes workflow-stage guard when foreground parallel clarify launches async", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-parallel-async-guard-"));
		const agents = [makeAgent("alpha"), makeAgent("beta")];
		const executor = makeExecutor(cwd, agents);
		const uiResult = {
			confirmed: true,
			runInBackground: true,
			templates: ["first clarified", "second clarified"],
			behaviorOverrides: [{}, {}],
		};

		const result = await executor.execute(
			"subagent",
			{
				tasks: [{ agent: "alpha", task: "first" }, { agent: "beta", task: "second" }],
				clarify: true,
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd, uiResult),
		);

		assertNoErrorFlag(result);
		assert.equal(runSyncCalls.length, 0);
		assert.equal(asyncChainCalls.length, 1);
		assert.equal(asyncChainCalls[0]!.params.maxSubagentDepth, 1);
		assert.equal(asyncChainCalls[0]!.params.workflowStageSubagentGuard, true);
	});

	test("passes workflow-stage guard when single clarify launches async", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-single-async-guard-"));
		const agents = [makeAgent("alpha")];
		const executor = makeExecutor(cwd, agents);
		const uiResult = {
			confirmed: true,
			runInBackground: true,
			templates: ["clarified single task"],
			behaviorOverrides: [{}],
		};

		const result = await executor.execute(
			"subagent",
			{
				agent: "alpha",
				task: "single task",
				clarify: true,
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd, uiResult),
		);

		assertNoErrorFlag(result);
		assert.equal(runSyncCalls.length, 0);
		assert.equal(asyncSingleCalls.length, 1);
		assert.equal(asyncSingleCalls[0]!.params.maxSubagentDepth, 1);
		assert.equal(asyncSingleCalls[0]!.params.workflowStageSubagentGuard, true);
	});

	test("suppresses stale parent update throws and preserves fork context on forwarded progress", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stale-parent-update-"));
		const agents = [makeAgent("alpha")];
		const executor = makeExecutor(cwd, agents);
		let parentUpdateCalls = 0;
		let forwardedContext: string | undefined;

		const ctx = makeWorkflowStageContext(cwd);
		const parentSessionFile = path.join(cwd, "parent-session.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		ctx.sessionManager = {
			...ctx.sessionManager,
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "leaf-1",
			getSessionDir: () => cwd,
			openSession: () => ({
				createBranchedSession: () => {
					const forkedSessionFile = path.join(cwd, "forked-session.jsonl");
					fs.writeFileSync(forkedSessionFile, "");
					return forkedSessionFile;
				},
			}),
		} as ExecutorContextForTest["sessionManager"];
		const result = await executor.execute(
			"subagent",
			{
				agent: "alpha",
				task: "throw stale parent",
				context: "fork",
				clarify: false,
			},
			new AbortController().signal,
			(update) => {
				parentUpdateCalls++;
				forwardedContext = update.details.context;
				throw new Error("Agent listener invoked outside active run");
			},
			ctx,
		);

		assertNoErrorFlag(result);
		assert.equal(parentUpdateCalls, 1);
		assert.equal(forwardedContext, "fork");
	});

	test("drops late subagent progress after executor lifecycle closes", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-late-parent-update-"));
		const agents = [makeAgent("alpha")];
		const executor = makeExecutor(cwd, agents);
		let parentUpdateCalls = 0;

		const result = await executor.execute(
			"subagent",
			{
				agent: "alpha",
				task: "late update",
				clarify: false,
			},
			new AbortController().signal,
			() => {
				parentUpdateCalls++;
			},
			makeWorkflowStageContext(cwd),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));

		assertNoErrorFlag(result);
		assert.equal(parentUpdateCalls, 0);
	});
});
