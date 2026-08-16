import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";

interface MinimalRunSyncOptions {
	maxSubagentDepth?: number;
	workflowStageSubagentGuard?: boolean;
}

interface CapturedRunSyncCall {
	agentName: string;
	options: MinimalRunSyncOptions;
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
			messages: [],
			usage: emptyUsage,
			finalOutput: `${agentName} output`,
		};
	},
);

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
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
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
		tempArtifactsDir: path.join(tempRoot, "artifacts"),
		getSubagentSessionRoot: () => path.join(tempRoot, "sessions"),
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents }),
		runtime: {
			runSync: runSyncMock,
		},
	} satisfies ExecutorDepsForTest;
	return createSubagentExecutor(deps);
}

function clearSubagentGuardEnv(): void {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
}

function resetCapturedCalls(): void {
	runSyncCalls.length = 0;
	runSyncMock.mockClear();
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
});

function cappedRunSyncDepths(): Record<string, number | undefined> {
	return Object.fromEntries(runSyncCalls.map((call) => [call.agentName, call.options.maxSubagentDepth]));
}

describe("per-agent maximum narrows every delegation mode", () => {
	// The stage constraint is 2; `capped` declares 1 in its own definition. Each
	// mode must hand the child the stricter of the two, not the stage limit.
	const cappedAgents = () => [makeAgent("capped", 1), makeAgent("uncapped")];

	test("a foreground single child receives its agent's tightened maximum", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-single-agent-max-"));
		const executor = makeExecutor(cappedAgents());

		const result = await executor.execute(
			"subagent",
			{ agent: "capped", task: "single task" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(result);
		assert.deepEqual(cappedRunSyncDepths(), { capped: 1 });
	});

	test("foreground parallel children each receive their own agent's maximum", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-parallel-agent-max-"));
		const executor = makeExecutor(cappedAgents());

		const result = await executor.execute(
			"subagent",
			{
				tasks: [
					{ agent: "capped", task: "first" },
					{ agent: "uncapped", task: "second" },
				],
			},
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(result);
		assert.deepEqual(cappedRunSyncDepths(), { capped: 1, uncapped: 2 });
	});
});
describe("retained foreground resume keeps the child's effective maximum", () => {
	test("a resumed child keeps the maximum its agent definition narrowed", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-retained-resume-max-"));
		// Config maximum 2, agent maximum 1: the resume must carry 1, not 2.
		const executor = makeExecutor([makeAgent("capped", 1)]);

		const initial = await executor.execute(
			"subagent",
			{ agent: "capped", task: "initial task" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(initial);
		assert.equal(runSyncCalls[0]?.options.maxSubagentDepth, 1);
		const runId = initial.details.runId;
		assert.ok(runId, "the initial delegation must retain a run id");

		// No live in-process control exists for this run, so resume falls back to the
		// retained foreground record, which is the path under test.
		const resumed = await executor.execute(
			"subagent",
			{ action: "resume", id: runId, message: "keep going" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(resumed);
		assert.equal(runSyncCalls[1]?.options.maxSubagentDepth, 1);
	});

	test("a resumed child without its own agent cap keeps the stage maximum", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-retained-resume-uncapped-"));
		const executor = makeExecutor([makeAgent("uncapped")]);

		const initial = await executor.execute(
			"subagent",
			{ agent: "uncapped", task: "initial task" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(initial);
		const runId = initial.details.runId;
		assert.ok(runId);

		const resumed = await executor.execute(
			"subagent",
			{ action: "resume", id: runId, message: "keep going" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(resumed);
		assert.equal(runSyncCalls[1]?.options.maxSubagentDepth, 2);
	});

	test("a widened agent definition cannot raise an already-retained child's maximum", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-retained-resume-widened-"));
		// The executor reads this array on every call, so editing it after the
		// initial run models an agent file edited between the run and the resume.
		const agents = [makeAgent("capped", 1)];
		const executor = makeExecutor(agents);

		const initial = await executor.execute(
			"subagent",
			{ agent: "capped", task: "initial task" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(initial);
		const runId = initial.details.runId;
		assert.ok(runId);

		agents[0] = makeAgent("capped");

		const resumed = await executor.execute(
			"subagent",
			{ action: "resume", id: runId, message: "keep going" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);

		assertNoErrorFlag(resumed);
		assert.equal(
			runSyncCalls[1]?.options.maxSubagentDepth,
			1,
			"the resume must use the limit recorded with the run, not the edited definition",
		);
	});
});
