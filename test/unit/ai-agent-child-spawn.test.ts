import assert from "node:assert/strict";
import type {
	ChildProcess,
	SpawnOptions,
	SpawnSyncOptionsWithStringEncoding,
	SpawnSyncReturns,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, vi } from "vitest";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
	runGitChecked,
} from "../../packages/subagents/src/runs/shared/worktree.js";

type RecordedSpawnOptions = SpawnSyncOptionsWithStringEncoding | (SpawnOptions & { input?: string });

interface SpawnObservation {
	command: string;
	args: string[];
	options: RecordedSpawnOptions | undefined;
}

const observations = vi.hoisted(() => [] as SpawnObservation[]);
const isGitCommand = vi.hoisted(() => (command: string) => /^git(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? ""));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawnSync = (
		command: string,
		args: string[],
		options?: SpawnSyncOptionsWithStringEncoding,
	): SpawnSyncReturns<string> => {
		observations.push({ command, args: [...args], options });
		if (isGitCommand(command)) return actual.spawnSync(command, args, options) as SpawnSyncReturns<string>;
		return {
			pid: process.pid,
			output: [null, '{"syntheticPaths":[]}', ""],
			stdout: '{"syntheticPaths":[]}',
			stderr: "",
			status: 0,
			signal: null,
		};
	};
	const spawn = (command: string, args: readonly string[] = [], options?: SpawnOptions): ChildProcess => {
		const recordedOptions: SpawnOptions & { input?: string } = {
			...(options ?? {}),
		};
		observations.push({ command, args: [...args], options: recordedOptions });
		if (isGitCommand(command)) return actual.spawn(command, args, options ?? {});
		const fake = new EventEmitter() as ChildProcess;
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stdinChunks: Buffer[] = [];
		stdin.on("data", (chunk: Buffer | string) => {
			stdinChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			recordedOptions.input = Buffer.concat(stdinChunks).toString("utf-8");
		});
		Object.assign(fake, {
			pid: process.pid,
			stdin,
			stdout,
			stderr,
			kill: () => true,
		});
		queueMicrotask(() => {
			stdout.end('{"syntheticPaths":[]}');
			stderr.end();
			fake.emit("close", 0, null);
		});
		return fake;
	};
	return { ...actual, spawn, spawnSync };
});

async function createRepository(prefix: string): Promise<{ root: string; repo: string }> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const repo = join(root, "repo");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	await runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	writeFileSync(join(repo, "tracked.txt"), "tracked\n");
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repo };
}

async function withCallerEnvironment<T>(callback: () => Promise<T> | T): Promise<T> {
	const previousAiAgent = process.env.AI_AGENT;
	const previousGitDir = process.env.GIT_DIR;
	process.env.AI_AGENT = "caller";
	process.env.GIT_DIR = "/tmp/not-this-repository.git";
	try {
		return await callback();
	} finally {
		if (previousAiAgent === undefined) delete process.env.AI_AGENT;
		else process.env.AI_AGENT = previousAiAgent;
		if (previousGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = previousGitDir;
	}
}

function assertAtomicGitSpawns(): void {
	const gitCalls = observations.filter((call) => isGitCommand(call.command));
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

test("subagent worktree Git and setup-hook spawns receive Atomic attribution", async () => {
	const { root, repo } = await createRepository("atomic-ai-agent-subagent-spawn-");
	const hook = join(root, "setup-hook");
	writeFileSync(hook, "placeholder\n");
	let setup: Awaited<ReturnType<typeof createSubagentWorktrees>> | undefined;
	try {
		observations.length = 0;
		await withCallerEnvironment(async () => {
			setup = await createSubagentWorktrees(repo, "env/subagent", 1, {
				setupHook: { hookPath: hook },
			});
			assertAtomicGitSpawns();
			assertSetupHookSpawn(hook, 30_000);
		});
	} finally {
		if (setup) await cleanupSubagentWorktrees(setup);
		rmSync(root, { recursive: true, force: true });
	}
});
