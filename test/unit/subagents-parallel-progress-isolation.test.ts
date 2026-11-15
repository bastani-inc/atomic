import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.ts";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { recoverCancelledChildOutput } from "../../packages/subagents/src/runs/shared/cancellation-recovery.ts";
import type { SingleResult, SubagentState } from "../../packages/subagents/src/shared/types.ts";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect, writeTextSync } from "../helpers/runtime.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function progressAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
		defaultProgress: true,
	};
}

function gitRepository(root: string): string {
	const repo = join(root, "repo");
	mkdirSync(repo);
	writeTextSync(join(repo, "seed.txt"), "seed\n");
	for (const args of [
		["init", "--quiet"],
		["config", "user.name", "Atomic Fixture"],
		["config", "user.email", "fixture@example.invalid"],
		["config", "commit.gpgSign", "false"],
		["add", "seed.txt"],
		["commit", "--quiet", "-m", "initial"],
	]) {
		const result = spawnSyncCollect(["git", ...args], { cwd: repo, env: createGitEnvironment() });
		assert.equal(result.exitCode, 0, result.stderr.toString());
	}
	return repo;
}

function context(repo: string, sessionRoot: string): ExtensionContext {
	return {
		cwd: repo,
		mode: "tui",
		hasUI: false,
		ui: {},
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => join(sessionRoot, "parent-session.jsonl"),
			getSessionId: () => "parent-session",
			getLeafId: () => null,
			getEntries: () => [],
		},
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

function executor(root: string, runSync: SubagentExecutorRuntimeDeps["runSync"]) {
	const state: SubagentState = {
		baseCwd: root,
		currentSessionId: "parent-session",
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
	return createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state,
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: join(root, "temp-artifacts"),
		getSubagentSessionRoot: () => join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [progressAgent()] }),
		runtime: { runSync },
	});
}

function progressPathFrom(task: string): string | undefined {
	return task.match(/progress at: ([^\r\n]+[\\/]progress\.md)/)?.[1];
}

test("parallel progress stays in run-scoped artifact storage, not the project directory (#4976)", async () => {
	const root = makeTempDirectory("atomic-parallel-progress-isolation-");
	clearSubagentControls();
	try {
		const repo = gitRepository(root);
		const sessionRoot = join(root, "session");
		const projectProgress = join(repo, "progress.md");
		const projectBytes = "# Project progress\n\nOwned by the project.\n";
		writeTextSync(projectProgress, projectBytes);
		const instructed: string[] = [];
		const result = await executor(root, async (_cwd, _agents, agent, task, options) => {
			const path = progressPathFrom(task);
			assert.ok(path, "each progress-enabled task is told where to keep progress");
			instructed.push(path);
			assert.equal(options.progressPath ?? path, path);
			writeTextSync(path, `${readFileSync(path, "utf8")}- ${agent} finding\n`);
			const outcome: SingleResult = { agent, task, status: "ok", messages: [], usage, finalOutput: "done" };
			return outcome;
		}).execute(
			"parallel-progress-isolation",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: true },
					{ agent: "analysis", task: "inspect b", progress: true },
				],
			},
			new AbortController().signal,
			undefined,
			context(repo, sessionRoot),
		);
		const runId = result.details?.runId;
		assert.ok(runId);
		const runProgress = join(sessionRoot, "subagent-artifacts", "progress", runId, "progress.md");
		assert.deepEqual(instructed, [runProgress, runProgress]);
		assert.equal(readFileSync(projectProgress, "utf8"), projectBytes);
		assert.match(readFileSync(runProgress, "utf8"), /- analysis finding\n- analysis finding\n/);
		const status = spawnSyncCollect(["git", "status", "--porcelain"], { cwd: repo, env: createGitEnvironment() });
		assert.equal(status.stdout.toString(), "?? progress.md\n", "only the project's own progress.md is untracked");
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});

test("parallel progress creates no progress.md in a project that has none (#4976)", async () => {
	const root = makeTempDirectory("atomic-parallel-progress-absent-");
	clearSubagentControls();
	try {
		const repo = gitRepository(root);
		await executor(root, async (_cwd, _agents, agent, task) => ({
			agent,
			task,
			status: "ok",
			messages: [],
			usage,
			finalOutput: "done",
		})).execute(
			"parallel-progress-absent",
			{ tasks: [{ agent: "analysis", task: "inspect a", progress: true }] },
			new AbortController().signal,
			undefined,
			context(repo, join(root, "session")),
		);
		assert.equal(existsSync(join(repo, "progress.md")), false);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});

test("parallel run without progress creates no progress storage or instruction (#4976)", async () => {
	const root = makeTempDirectory("atomic-parallel-progress-disabled-");
	clearSubagentControls();
	try {
		const repo = gitRepository(root);
		const sessionRoot = join(root, "session");
		const seen: Array<{ task: string; progressPath?: string }> = [];
		const result = await executor(root, async (_cwd, _agents, agent, task, options) => {
			seen.push({ task, progressPath: options.progressPath });
			return { agent, task, status: "ok", messages: [], usage, finalOutput: "done" };
		}).execute(
			"parallel-progress-disabled",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: false },
					{ agent: "analysis", task: "inspect b", progress: false },
				],
			},
			new AbortController().signal,
			undefined,
			context(repo, sessionRoot),
		);
		const runId = result.details?.runId;
		assert.ok(runId);
		assert.deepEqual(
			seen.sort((left, right) => left.task.localeCompare(right.task)),
			[
				{ task: "inspect a", progressPath: undefined },
				{ task: "inspect b", progressPath: undefined },
			],
		);
		assert.equal(existsSync(join(sessionRoot, "subagent-artifacts", "progress", runId)), false);
		assert.equal(existsSync(join(repo, "progress.md")), false);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});

test("parallel cancellation recovers partial findings from run-scoped progress (#4976)", async () => {
	const root = makeTempDirectory("atomic-parallel-progress-recovery-");
	clearSubagentControls();
	try {
		const repo = gitRepository(root);
		const result = await executor(root, async (_cwd, _agents, agent, task, options) => {
			if (options.progressPath) writeTextSync(options.progressPath, "# Progress\n\n- Run-scoped finding\n");
			const recovered = recoverCancelledChildOutput({
				progressPath: options.progressPath,
				progressArtifactPath: options.progressArtifactPath,
			});
			return {
				agent,
				task,
				status: "interrupted",
				interrupted: true,
				cause: "abort",
				envelope: recovered.text,
				finalOutput: recovered.text,
				messages: [],
				usage,
			};
		}).execute(
			"parallel-progress-recovery",
			{
				tasks: [
					{ agent: "analysis", task: "inspect a", progress: true },
					{ agent: "analysis", task: "inspect b", progress: true },
				],
			},
			new AbortController().signal,
			undefined,
			context(repo, join(root, "session")),
		);
		const text = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const runId = result.details?.runId;
		assert.ok(runId);
		const runProgress = join(root, "session", "subagent-artifacts", "progress", runId, "progress.md");
		assert.match(text, /Partial findings from progress\.md/);
		assert.match(text, /Run-scoped finding/);
		assert.ok(text.includes(`Progress: ${runProgress}`));
		assert.equal(existsSync(join(repo, "progress.md")), false);
	} finally {
		clearSubagentControls();
		removeTempDirectory(root);
	}
});
