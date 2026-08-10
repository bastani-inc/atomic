import assert from "node:assert/strict";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import {
	cleanupWorktrees as cleanupWorkflowWorktrees,
	createWorktrees as createWorkflowWorktrees,
} from "../../packages/workflows/src/runs/shared/worktree-setup.js";

interface SpawnObservation {
	command: string;
	args: string[];
	options: SpawnSyncOptionsWithStringEncoding | undefined;
}

const observations = vi.hoisted(() => [] as SpawnObservation[]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawnSync = (
		command: string,
		args: string[],
		options?: SpawnSyncOptionsWithStringEncoding,
	): SpawnSyncReturns<string> => {
		observations.push({ command, args: [...args], options });
		if (command === "git") return actual.spawnSync(command, args, options) as SpawnSyncReturns<string>;
		return {
			pid: process.pid,
			output: [null, '{"syntheticPaths":[]}', ""],
			stdout: '{"syntheticPaths":[]}',
			stderr: "",
			status: 0,
			signal: null,
		};
	};
	return { ...actual, spawnSync };
});

function createRepository(prefix: string): { root: string; repo: string } {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const repo = join(root, "repo");
	mkdirSync(repo);
	runGitChecked(repo, ["init", "-b", "main"]);
	runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	writeFileSync(join(repo, "tracked.txt"), "tracked\n");
	runGitChecked(repo, ["add", "."]);
	runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repo };
}

function withCallerEnvironment<T>(callback: () => T): T {
	const previousAiAgent = process.env.AI_AGENT;
	const previousGitDir = process.env.GIT_DIR;
	process.env.AI_AGENT = "caller";
	process.env.GIT_DIR = "/tmp/not-this-repository.git";
	try {
		return callback();
	} finally {
		if (previousAiAgent === undefined) delete process.env.AI_AGENT;
		else process.env.AI_AGENT = previousAiAgent;
		if (previousGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = previousGitDir;
	}
}

function assertAtomicGitSpawns(): void {
	const gitCalls = observations.filter((call) => call.command === "git");
	assert.ok(gitCalls.length > 0, "the worktree lifecycle must spawn Git");
	for (const call of gitCalls) {
		assert.equal(call.options?.env?.AI_AGENT, "atomic");
		assert.equal(call.options?.env?.GIT_DIR, undefined);
	}
}

function assertSetupHookSpawn(hookPath: string, timeout: number): void {
	const hookCall = observations.find((call) => call.command === hookPath);
	assert.ok(hookCall, "the worktree setup hook must be spawned");
	assert.deepEqual(hookCall.args, []);
	assert.ok(typeof hookCall.options?.cwd === "string" && hookCall.options.cwd.endsWith("-0"));
	assert.equal(hookCall.options?.shell, false);
	assert.equal(hookCall.options?.timeout, timeout);
	assert.equal(hookCall.options?.env?.AI_AGENT, "atomic");
	assert.equal(hookCall.options?.env?.GIT_DIR, "/tmp/not-this-repository.git");
	assert.equal(typeof hookCall.options?.input, "string");
}

test("subagent worktree Git and setup-hook spawns receive Atomic attribution", () => {
	const { root, repo } = createRepository("atomic-ai-agent-subagent-spawn-");
	const hook = join(root, "setup-hook");
	writeFileSync(hook, "placeholder\n");
	let setup: ReturnType<typeof createSubagentWorktrees> | undefined;
	try {
		observations.length = 0;
		withCallerEnvironment(() => {
			setup = createSubagentWorktrees(repo, "env/subagent", 1, {
				setupHook: { hookPath: hook },
			});
			assertAtomicGitSpawns();
			assertSetupHookSpawn(hook, 30_000);
		});
	} finally {
		if (setup) cleanupSubagentWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});

test("workflow worktree Git and setup-hook spawns receive Atomic attribution", () => {
	const { root, repo } = createRepository("atomic-ai-agent-workflow-spawn-");
	const hook = join(root, "setup-hook");
	writeFileSync(hook, "placeholder\n");
	let setup: ReturnType<typeof createWorkflowWorktrees> | undefined;
	try {
		observations.length = 0;
		withCallerEnvironment(() => {
			setup = createWorkflowWorktrees(repo, "env/workflow", 1, {
				baseBranch: "main",
				symlinkDirectories: [],
				setupHook: { hookPath: hook, timeoutMs: 1_234 },
			});
			assertAtomicGitSpawns();
			assertSetupHookSpawn(hook, 1_234);
		});
	} finally {
		if (setup) cleanupWorkflowWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});
