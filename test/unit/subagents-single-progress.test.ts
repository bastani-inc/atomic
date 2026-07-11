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

function extractProgressPath(task: string): string {
	return task.match(/Create and maintain progress at: ([^\r\n]+[\\/]progress\.md)/)?.[1] ?? "";
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

test("foreground artifacts-disabled progress storage is removed after success", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-cleanup-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.ok(progressPath);
				assert.equal(existsSync(progressPath), true, "progress storage must exist while the child runs");
				return makeResult(task);
			},
		});

		const result = await executor.execute("cleanup", {
			agent: "worker", task: "implement", progress: true, artifacts: false,
		}, new AbortController().signal, undefined, makeContext(cwd));

		assert.equal(result.isError, undefined);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after child failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-failure-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				return { ...makeResult(task), exitCode: 1, error: "failed" };
			},
		});

		const result = await executor.execute("cleanup-failure", {
			agent: "worker", task: "implement", progress: true, artifacts: false,
		}, new AbortController().signal, undefined, makeContext(cwd));

		assert.equal(result.isError, true);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after a synchronous runtime throw", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-sync-throw-"));
	try {
		let progressPath = "";
		const originalError = new Error("sync runtime failure");
		const executor = makeExecutor(cwd, {
			runSync: (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				throw originalError;
			},
		});

		const result = await executor.execute("cleanup-sync-throw", {
			agent: "worker", task: "implement", progress: true, artifacts: false,
		}, new AbortController().signal, undefined, makeContext(cwd));
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /sync runtime failure/);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground artifacts-disabled progress storage is removed after a rejected runtime promise", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-rejection-"));
	try {
		let progressPath = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				progressPath = extractProgressPath(task);
				assert.equal(existsSync(progressPath), true);
				throw new Error("async runtime failure");
			},
		});

		const result = await executor.execute("cleanup-rejection", {
			agent: "worker", task: "implement", progress: true, artifacts: false,
		}, new AbortController().signal, undefined, makeContext(cwd));
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /async runtime failure/);
		assert.equal(existsSync(progressPath), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("foreground detached child retains artifacts-disabled progress storage until runtime reports exit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-progress-detached-"));
	try {
		let progressPath = "";
		let reportDetachedExit: (() => void) | undefined;
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task, options) => {
				progressPath = extractProgressPath(task);
				reportDetachedExit = options.onDetachedExit;
				return { ...makeResult(task), detached: true };
			},
		});

		await executor.execute("retain-detached", {
			agent: "worker", task: "implement", progress: true, artifacts: false,
		}, new AbortController().signal, undefined, makeContext(cwd));

		assert.equal(existsSync(progressPath), true, "detached child may still write progress");
		assert.ok(reportDetachedExit);
		reportDetachedExit();
		assert.equal(existsSync(progressPath), false, "progress storage is transient after detached child exit");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("foreground read-only task suppresses inherited defaultProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-readonly-progress-"));
	try {
		let capturedTask = "";
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => {
				capturedTask = task;
				return makeResult(task);
			},
		}, false, true);

		await executor.execute("readonly", {
			agent: "worker", task: "Inspect only; do not edit files.",
		}, new AbortController().signal, undefined, makeContext(cwd));

		assert.doesNotMatch(capturedTask, /Create and maintain progress/);
		assert.equal(existsSync(join(cwd, "subagent-artifacts", "progress")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume inherits single-agent defaultProgress", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-progress-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedProgress: boolean | undefined;
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => ({ ...makeResult(task), sessionFile }),
			executeAsyncSingle: (_id, params) => {
				resumedProgress = params.progress;
				return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [], asyncId: "revived" } };
			},
		}, false, true);
		const context = makeContext(cwd);
		const initial = await executor.execute("initial", { agent: "worker", task: "implement" }, new AbortController().signal, undefined, context);
		assert.ok(initial.details?.runId);

		const resumed = await executor.execute("resume", {
			action: "resume", id: initial.details.runId, message: "continue implementation",
		}, new AbortController().signal, undefined, context);

		assert.equal(resumed.isError, undefined);
		assert.equal(resumedProgress, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume suppresses inherited defaultProgress for a read-only follow-up", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-readonly-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedProgress: boolean | undefined;
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => ({ ...makeResult(task), sessionFile }),
			executeAsyncSingle: (_id, params) => {
				resumedProgress = params.progress;
				return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [], asyncId: "revived" } };
			},
		}, false, true);
		const context = makeContext(cwd);
		const initial = await executor.execute("initial", { agent: "worker", task: "implement" }, new AbortController().signal, undefined, context);
		assert.ok(initial.details?.runId);

		await executor.execute("resume", {
			action: "resume", id: initial.details.runId, message: "Review only; do not edit files.",
		}, new AbortController().signal, undefined, context);

		assert.equal(resumedProgress, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume explicit progress overrides read-only suppression", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-explicit-"));
	try {
		const sessionFile = join(cwd, "worker.jsonl");
		writeFileSync(sessionFile, "");
		let resumedProgress: boolean | undefined;
		const executor = makeExecutor(cwd, {
			runSync: async (_cwd, _agents, _agent, task) => ({ ...makeResult(task), sessionFile }),
			executeAsyncSingle: (_id, params) => {
				resumedProgress = params.progress;
				return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [], asyncId: "revived" } };
			},
		}, false, true);
		const context = makeContext(cwd);
		const initial = await executor.execute("initial", { agent: "worker", task: "implement" }, new AbortController().signal, undefined, context);
		assert.ok(initial.details?.runId);

		await executor.execute("resume", {
			action: "resume", id: initial.details.runId, message: "Review only; do not edit files.", progress: true,
		}, new AbortController().signal, undefined, context);

		assert.equal(resumedProgress, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
