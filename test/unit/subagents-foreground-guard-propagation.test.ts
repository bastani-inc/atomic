import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { afterAll, beforeEach, describe, test, vi } from "vitest";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";

interface MinimalRunSyncOptions {
	workflowStageSubagentGuard?: boolean;
	parentDepth?: number;
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
		const interrupted = task === "initial task";
		return {
			agent: agentName,
			task,
			status: interrupted ? ("interrupted" as const) : ("ok" as const),
			messages: [],
			usage: emptyUsage,
			finalOutput: `${agentName} output`,
			...(interrupted ? { interrupted: true } : {}),
		};
	},
);

function makeAgent(name: string): MinimalAgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

function makeState() {
	return {
		baseCwd: "",
		currentSessionId: null,
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
		hasNonBuiltinExtensions: false,
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
			constraints: { disableWorkflowTool: true },
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
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
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
		assert.equal(call.options.parentDepth, 0);
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

	test("passes workflow-stage guard to a foreground single child", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-single-guard-"));
		const executor = makeExecutor([makeAgent("alpha")]);
		const result = await executor.execute(
			"subagent",
			{ agent: "alpha", task: "first" },
			new AbortController().signal,
			undefined,
			makeWorkflowStageContext(cwd),
		);
		assertNoErrorFlag(result);
		assertGuardedRunSyncCalls(["alpha"]);
	});
});
