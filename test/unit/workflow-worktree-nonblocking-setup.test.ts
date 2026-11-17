import assert from "node:assert/strict";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageExecutionMeta } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { testRunId } from "../helpers/run-id.js";

/** Every synchronous spawn of git, which a running workflow must never make. */
const syncGitSpawns = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawnSync = ((command: string, args?: readonly string[], options?: SpawnSyncOptions) => {
		if (/(^|[\\/])git(\.exe)?$/i.test(command)) syncGitSpawns.push([...(args ?? [])]);
		return actual.spawnSync(command, args ?? [], options ?? {}) as SpawnSyncReturns<string | Buffer>;
	}) as typeof actual.spawnSync;
	return { ...actual, spawnSync };
});

let root: string;
let repo: string;
let sourceCwd: string;

beforeEach(async () => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-nonblocking-worktree-")));
	repo = join(root, "repo");
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	writeFileSync(join(repo, "packages", "api", "tracked.txt"), "tracked\n");
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, [
		"-c",
		"user.name=Atomic Test",
		"-c",
		"user.email=atomic-test@example.com",
		"commit",
		"--no-gpg-sign",
		"-m",
		"initial",
	]);
	sourceCwd = join(repo, "packages", "api");
	syncGitSpawns.length = 0;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A complete adapter that records the directory each stage runs in. */
function recordingAdapters(cwds: Map<string, string | undefined>) {
	return {
		complete: {
			complete: async (text: string, _options: object | undefined, meta: StageExecutionMeta) => {
				cwds.set(meta.stageName, meta.stageOptions?.cwd);
				return text;
			},
		},
	};
}

test("a worktree-input run's stages run in the worktree, which is set up without blocking on git", async () => {
	const stageCwds = new Map<string, string | undefined>();
	const otherWorktree = join(root, "other-wt");
	let otherExistedAtSpawn: boolean | undefined;
	const def = workflow({
		name: "worktree-input-stages",
		description: "",
		inputs: { git_worktree_dir: Type.String() },
		outputs: { cwd: Type.String() },
		worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
		run: async (ctx) => {
			await ctx.stage("first").complete("one");
			await ctx.stage("second").complete("two");
			// The stage is returned at once; its own worktree is set up before it does any work.
			const explicit = ctx.stage("explicit", { gitWorktreeDir: otherWorktree });
			otherExistedAtSpawn = existsSync(otherWorktree);
			await explicit.complete("three");
			return { cwd: ctx.cwd ?? "" };
		},
	});
	const result = await run(
		def,
		{ git_worktree_dir: "../input-wt" },
		{
			runId: testRunId("worktree-input-stages"),
			cwd: sourceCwd,
			store: createStore(),
			durableBackend: await JournalTestBackend.create(),
			adapters: recordingAdapters(stageCwds),
		},
	);

	const inputWorktreeCwd = join(root, "input-wt", "packages", "api");
	assert.equal(result.status, "completed", result.error);
	assert.equal(result.result?.cwd, inputWorktreeCwd);
	assert.equal(stageCwds.get("first"), inputWorktreeCwd);
	assert.equal(stageCwds.get("second"), inputWorktreeCwd);
	assert.equal(otherExistedAtSpawn, false, "the stage's worktree is not set up while it spawns");
	assert.equal(stageCwds.get("explicit"), join(otherWorktree, "packages", "api"));
	assert.deepEqual(syncGitSpawns, [], "no git command ran synchronously");
});

test("a stage whose worktree cannot be set up fails its call with the setup error", async () => {
	const notADirectory = join(root, "not-a-directory");
	writeFileSync(notADirectory, "a file where the worktree belongs\n");
	const stageCwds = new Map<string, string | undefined>();
	let spawned = false;
	const def = workflow({
		name: "worktree-stage-setup-failure",
		description: "",
		inputs: {},
		outputs: { error: Type.String() },
		run: async (ctx) => {
			const stage = ctx.stage("broken", { gitWorktreeDir: notADirectory });
			spawned = true;
			try {
				await stage.complete("never sent");
				return { error: "" };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	const store = createStore();
	const runId = testRunId("worktree-stage-setup-failure");
	const result = await run(
		def,
		{},
		{
			runId,
			cwd: sourceCwd,
			store,
			durableBackend: await JournalTestBackend.create(),
			adapters: recordingAdapters(stageCwds),
		},
	);

	assert.equal(spawned, true);
	assert.match(String(result.result?.error), /gitWorktreeDir already exists but is not a directory/);
	assert.equal(stageCwds.has("broken"), false, "the stage never ran");
	const stage = store.run(runId)?.stages.find((candidate) => candidate.name === "broken");
	assert.equal(stage?.status, "failed");
});

test("a child run whose input worktree cannot be set up reports it where it reads its directory", async () => {
	const notADirectory = join(root, "child-not-a-directory");
	writeFileSync(notADirectory, "a file where the worktree belongs\n");
	const child = workflow({
		name: "worktree-child-reads-cwd",
		description: "",
		inputs: { git_worktree_dir: Type.String() },
		outputs: { error: Type.String() },
		worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
		run: async (ctx) => {
			let read: string;
			try {
				read = `read ${ctx.cwd}`;
			} catch (error) {
				read = error instanceof Error ? error.message : String(error);
			}
			await ctx.tool("after-read", {}, async () => true);
			return { error: read };
		},
	});
	const parent = workflow({
		name: "worktree-child-parent",
		description: "",
		inputs: {},
		outputs: { error: Type.String() },
		run: async (ctx) => {
			const result = await ctx.workflow(child, { inputs: { git_worktree_dir: notADirectory } });
			return { error: String(result.outputs.error) };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId: testRunId("worktree-child-parent"),
			cwd: sourceCwd,
			store: createStore(),
			durableBackend: await JournalTestBackend.create(),
			// Workspace snapshots read the run's directory at each checkpoint; here only the body reads it.
			snapshots: { enabled: false },
		},
	);

	assert.equal(result.status, "completed", result.error);
	assert.match(String(result.result?.error), /gitWorktreeDir already exists but is not a directory/);
});
