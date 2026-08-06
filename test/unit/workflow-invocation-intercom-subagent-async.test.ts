import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { runSync as runInProcessSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.js";

function makeState(): ExecutorDeps["state"] {
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

function stageContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T } as unknown as ExtensionContext["ui"],
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] } as unknown as ExtensionContext["modelRegistry"],
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "workflow-stage-session",
			getLeafId: () => null,
		} as ExtensionContext["sessionManager"],
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: "root",
			workflowStageId: "launcher",
			workflowStageName: "launcher",
			intercomGroup: "workflow:root",
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
	} satisfies ExtensionContext;
}

test("async single, parallel, and chain children inherit workflow groups through in-process execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-workflow-group-async-"));
	const groups: Array<string | undefined> = [];
	const agent = {
		name: "worker",
		description: "test worker",
		systemPromptMode: "replace" as const,
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "work",
		source: "project" as const,
		filePath: join(root, "worker.md"),
	};
	const pi: Pick<ExecutorDeps["pi"], "events" | "getSessionName"> = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "workflow-stage",
	};
	try {
		const executor = createSubagentExecutor({
			pi: pi as ExecutorDeps["pi"],
			state: makeState(),
			config: { maxSubagentDepth: 2, parallel: { concurrency: 2, maxTasks: 10 } },
			asyncByDefault: false,
			tempArtifactsDir: join(root, "artifacts"),
			getSubagentSessionRoot: () => join(root, "sessions"),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [agent] }),
			runtime: {
				runSync: async (_cwd, _agents, agentName, task, options) => {
					groups.push(options.intercomGroup);
					return {
						agent: agentName,
						task,
						status: "ok",
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						finalOutput: "done",
					};
				},
				isAsyncAvailable: () => true,
				executeAsyncSingle: (id, params) => {
					groups.push(
						params.group === true ? params.ctx.intercomGroup : (params.group ?? params.ctx.intercomGroup),
					);
					return executeAsyncSingle(id, { ...params, testSession: { output: "done" } });
				},
			},
		});
		const context = stageContext(root);
		const single = await executor.execute(
			"async-single",
			{ agent: "worker", task: "inherit", async: true },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(single.isError, undefined);
		assert.equal(single.details.results[0]?.status, "continued");
		assert.ok(single.details.results[0]?.path);

		const explicitSingle = await executor.execute(
			"async-single-explicit",
			{ agent: "worker", task: "default", async: true, group: "default" },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(explicitSingle.isError, undefined);

		const parallel = await executor.execute(
			"async-parallel",
			{
				tasks: [
					{ agent: "worker", task: "parallel-inherit" },
					{ agent: "worker", task: "parallel-default", group: "default" },
				],
				group: "parallel-set",
				async: true,
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(parallel.isError, undefined);
		assert.equal(parallel.details.results[0]?.status, "continued");

		const chain = await executor.execute(
			"async-chain",
			{
				chain: [
					{ agent: "worker", task: "chain-inherit" },
					{ agent: "worker", task: "chain-default", group: "default" },
				],
				group: "chain-top",
				async: true,
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(chain.isError, undefined);
		assert.equal(chain.details.results[0]?.status, "continued");
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	assert.ok(groups.includes("workflow:root"));
	assert.ok(groups.includes("default"));
	assert.ok(groups.includes("parallel-set"));
	assert.ok(groups.includes("chain-top"));
});

test("in-process child resolves intercom group through typed admission without an env bridge", async () => {
	const previousGroup = process.env.ATOMIC_INTERCOM_GROUP;
	process.env.ATOMIC_INTERCOM_GROUP = "ambient-group";
	const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-group-inprocess-"));
	try {
		const agent = {
			name: "worker",
			description: "test worker",
			systemPromptMode: "replace" as const,
			inheritProjectContext: false,
			inheritSkills: false,
			systemPrompt: "work",
			source: "project" as const,
			filePath: join(dir, "worker.md"),
		};
		const result = await runInProcessSync(dir, [agent], "worker", "work", {
			cwd: dir,
			runId: "inprocess-group",
			intercomGroup: "workflow:root",
			testSession: { output: "done" },
		});
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "done");
		assert.equal(process.env.ATOMIC_INTERCOM_GROUP, "ambient-group");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (previousGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
		else process.env.ATOMIC_INTERCOM_GROUP = previousGroup;
	}
});
