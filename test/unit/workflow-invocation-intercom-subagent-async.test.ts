import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { executeAsyncChain } from "../../packages/subagents/src/runs/background/async-execution-chain.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/background/async-execution-single.js";
import { runSingleStep } from "../../packages/subagents/src/runs/background/subagent-runner-step.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { successEvent, withFakeCli } from "./subagents-attempt-watchdog-helpers.js";

interface CapturedRunnerStep {
	intercomGroup?: string;
	parallel?: CapturedRunnerStep[];
}

interface CapturedRunnerConfig {
	steps: CapturedRunnerStep[];
}

function capturedGroups(config: CapturedRunnerConfig): Array<string | undefined> {
	return config.steps.flatMap((step) => step.parallel?.map((child) => child.intercomGroup) ?? [step.intercomGroup]);
}

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

test("async single, parallel, and chain children inherit the workflow group with explicit overrides", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-workflow-group-async-"));
	const configs: CapturedRunnerConfig[] = [];
	const state = makeState();
	const sessionFile = join(root, "child.jsonl");
	writeFileSync(sessionFile, "{}\n");
	const pi: Pick<ExecutorDeps["pi"], "events" | "getSessionName"> = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "workflow-stage",
	};
	try {
		const executor = createSubagentExecutor({
			pi: pi as ExecutorDeps["pi"],
			state,
			config: { maxSubagentDepth: 2, parallel: { concurrency: 2, maxTasks: 10 } },
			asyncByDefault: false,
			tempArtifactsDir: join(root, "artifacts"),
			getSubagentSessionRoot: () => join(root, "sessions"),
			expandTilde: (path) => path,
			discoverAgents: () => ({
				agents: [
					{
						name: "worker",
						description: "test worker",
						systemPromptMode: "replace",
						inheritProjectContext: false,
						inheritSkills: false,
						systemPrompt: "work",
						source: "project",
						filePath: join(root, "worker.md"),
					},
				],
			}),
			runtime: {
				runSync: async (_cwd, _agents, agent, task) => ({
					agent,
					task,
					exitCode: 0,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "done",
					sessionFile,
				}),
				isAsyncAvailable: () => true,
				executeAsyncSingle: (id, params) =>
					executeAsyncSingle(id, {
						...params,
						spawnRunner(config) {
							configs.push(config as CapturedRunnerConfig);
							return { pid: 1234 };
						},
					}),
				executeAsyncChain: (id, params) =>
					executeAsyncChain(id, {
						...params,
						spawnRunner(config) {
							configs.push(config as CapturedRunnerConfig);
							return { pid: 1234 };
						},
					}),
			},
		});
		const context = stageContext(root);
		for (const params of [
			{ agent: "worker", task: "inherit", async: true },
			{ agent: "worker", task: "default", async: true, group: "default" },
		] as const) {
			const result = await executor.execute(
				"async-single",
				params,
				new AbortController().signal,
				undefined,
				context,
			);
			assert.equal(result.isError, undefined);
		}
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

		const foreground = await executor.execute(
			"foreground-source",
			{
				agent: "worker",
				task: "persist source",
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(foreground.isError, undefined);
		assert.ok(foreground.details.runId);
		for (const group of [undefined, "default"] as const) {
			const revived = await executor.execute(
				"revive",
				{
					action: "resume",
					id: foreground.details.runId,
					message: "continue",
					...(group ? { group } : {}),
				},
				new AbortController().signal,
				undefined,
				context,
			);
			assert.equal(revived.isError, undefined);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	assert.deepEqual(configs.map(capturedGroups), [
		["workflow:root"],
		["default"],
		["parallel-set", "default"],
		["chain-top", "default"],
		["workflow:root"],
		["default"],
	]);
});

test("the async runner clears a serialized group when the child lacks Intercom access", async () => {
	const previousGroup = process.env.ATOMIC_INTERCOM_GROUP;
	process.env.ATOMIC_INTERCOM_GROUP = "ambient-group";
	try {
		await withFakeCli(
			`
      import { writeFileSync } from "node:fs";
      writeFileSync(new URL("./intercom-group.txt", import.meta.url), process.env.ATOMIC_INTERCOM_GROUP ?? "missing");
      console.log(${JSON.stringify(successEvent("done"))});
    `,
			async (dir) => {
				const step = {
					agent: "worker",
					task: "work",
					intercomGroup: "workflow:root",
					inheritProjectContext: false,
					inheritSkills: false,
				};
				const context = {
					previousOutput: "",
					placeholder: "{previous}",
					cwd: dir,
					sessionEnabled: false,
					id: "async-group-runner",
					flatIndex: 0,
					flatStepCount: 1,
					outputFile: join(dir, "output.txt"),
				};
				const grouped = await runSingleStep(step, {
					...context,
					childIntercomTarget: "async-child",
				});
				assert.equal(grouped.exitCode, 0);
				assert.equal(readFileSync(join(dir, "intercom-group.txt"), "utf8"), "workflow:root");

				const ungrouped = await runSingleStep(step, {
					...context,
					outputFile: join(dir, "ungrouped-output.txt"),
				});
				assert.equal(ungrouped.exitCode, 0);
				assert.equal(readFileSync(join(dir, "intercom-group.txt"), "utf8"), "");
			},
			{ idleMs: 4_000, wallMs: 8_000 },
		);
	} finally {
		if (previousGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
		else process.env.ATOMIC_INTERCOM_GROUP = previousGroup;
	}
});
