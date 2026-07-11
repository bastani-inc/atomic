import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { ExtensionContext } from "@bastani/atomic";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps, SubagentExecutorRuntimeDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeAgent(defaultProgress?: boolean): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: "/tmp/worker.md",
		defaultProgress,
	};
}

function makeResult(task: string): SingleResult {
	return { agent: "worker", task, exitCode: 0, messages: [], usage, finalOutput: "done" };
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionFile: () => join(cwd, "parent-session.jsonl"), getSessionId: () => "parent", getLeafId: () => null },
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function makeExecutor(cwd: string, runtime: Partial<SubagentExecutorRuntimeDeps>, asyncByDefault = false, defaultProgress?: boolean) {
	const state: ExecutorDeps["state"] = {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		subagentInProgress: false,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
	return createSubagentExecutor({
		pi: { events: { on: () => () => {}, emit: () => {} }, getSessionName: () => "parent" } as unknown as ExecutorDeps["pi"],
		state,
		config: { asyncByDefault, maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 50 } },
		asyncByDefault,
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent(defaultProgress)] }),
		runtime,
	});
}

test("root progress true is schema-valid and independent from includeProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-root-progress-"));
	try {
		const captured: string[] = [];
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				captured.push(task);
				return makeResult(task);
			},
		});
		const context = makeContext(cwd);
		const cwdProgressPath = join(cwd, "progress.md");
		writeFileSync(cwdProgressPath, "project sentinel");
		const invocation = { agent: "worker", task: "review only; do not edit files", progress: true };
		assert.equal(Value.Check(SubagentParams, invocation), true);
		const result = await executor.execute("explicit", invocation, new AbortController().signal, undefined, context);
		const runId = result.details?.runId;
		assert.ok(runId);
		const progressPath = join(cwd, "subagent-artifacts", "progress", runId, "progress.md");
		assert.ok((captured[0] ?? "").includes(`Create and maintain progress at: ${progressPath}`));
		assert.equal(existsSync(progressPath), true);
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel");

		await executor.execute("telemetry", {
			agent: "worker", task: "inspect behavior", includeProgress: true,
		}, new AbortController().signal, undefined, context);
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel", "includeProgress must not enable file tracking");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("single progress false overrides default and omission inherits it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-default-progress-"));
	try {
		const tasks: string[] = [];
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				tasks.push(task);
				return makeResult(task);
			},
		}, false, true);
		const context = makeContext(cwd);
		await executor.execute("disabled", {
			agent: "worker", task: "implement one", progress: false,
		}, new AbortController().signal, undefined, context);
		assert.doesNotMatch(tasks[0] ?? "", /Create and maintain progress/);
		assert.equal(existsSync(join(cwd, "progress.md")), false);

		const result = await executor.execute("inherited", {
			agent: "worker", task: "implement two",
		}, new AbortController().signal, undefined, context);
		const runId = result.details?.runId;
		assert.ok(runId);
		const progressPath = join(cwd, "subagent-artifacts", "progress", runId, "progress.md");
		assert.ok((tasks[1] ?? "").includes(`Create and maintain progress at: ${progressPath}`));
		assert.match(readFileSync(progressPath, "utf8"), /# Progress/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
