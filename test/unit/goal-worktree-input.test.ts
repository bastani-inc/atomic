import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import goal from "../../packages/workflows/builtin/goal.js";
import {
	gitFailureMessage,
	gitTopLevelFromResult,
	isGitTimeoutResult,
	runGitChecked,
	setupGitWorktree,
	setupGitWorktreeCached,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import type {
	GitWorktreeSetupOptions,
	GitWorktreeSetupResult,
} from "../../packages/workflows/src/runs/shared/worktree-types.js";

const SETUP_DRIVERS: ReadonlyArray<
	readonly [string, (options: GitWorktreeSetupOptions) => Promise<GitWorktreeSetupResult>]
> = [
	["the synchronous SDK setup", async (options) => setupGitWorktree(options)],
	["the engine's non-blocking setup", (options) => setupGitWorktreeCached(options)],
];

async function createGitRepo(): Promise<{ readonly root: string; readonly repo: string }> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-goal-worktree-test-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.email", "test@example.com"]);
	await runGitChecked(repo, ["config", "user.name", "Test User"]);
	await runGitChecked(repo, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(repo, "README.md"), "main\n");
	await runGitChecked(repo, ["add", "README.md"]);
	await runGitChecked(repo, ["commit", "-m", "initial"]);
	await runGitChecked(repo, ["checkout", "-b", "goal-base"]);
	writeFileSync(join(repo, "base-only.txt"), "created from base branch\n");
	await runGitChecked(repo, ["add", "base-only.txt"]);
	await runGitChecked(repo, ["commit", "-m", "base marker"]);
	await runGitChecked(repo, ["checkout", "main"]);
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	return { root, repo };
}

describe("goal git_worktree_dir input", () => {
	test("binds git_worktree_dir and base_branch for executor worktree setup", () => {
		assert.deepEqual(goal.inputBindings?.worktree, {
			gitWorktreeDir: "git_worktree_dir",
			baseBranch: "base_branch",
		});
	});

	test("formats git subprocess timeouts as timeouts instead of repository detection failures", () => {
		const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
		const result = { stdout: "", stderr: "", status: null, error };
		assert.equal(isGitTimeoutResult(result), true);
		assert.match(gitFailureMessage(result), /timed out after 60000ms/);
		assert.match(gitFailureMessage(result), /ETIMEDOUT/);
	});

	test("preserves git timeout diagnostics while validating existing worktree roots", () => {
		const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
		assert.throws(
			() =>
				gitTopLevelFromResult(
					{ stdout: "", stderr: "", status: null, error },
					"/tmp/reused-wt",
					"gitWorktreeDir /tmp/reused-wt",
				),
			/Timed out while validating gitWorktreeDir \/tmp\/reused-wt.*ETIMEDOUT/,
		);
	});
});

describe.each(SETUP_DRIVERS)("git_worktree_dir setup through %s", (_driver, setup) => {
	test("creates missing relative worktrees from base_branch and reuses existing ones", async () => {
		const { root, repo } = await createGitRepo();
		try {
			const sourceCwd = join(repo, "packages", "api");
			const created = await setup({
				cwd: sourceCwd,
				gitWorktreeDir: "../goal-created-wt",
				baseBranch: "goal-base",
			});

			assert.equal(created.created, true);
			assert.equal(created.worktreeRoot, join(root, "goal-created-wt"));
			assert.equal(created.cwd, join(root, "goal-created-wt", "packages", "api"));
			assert.equal(existsSync(join(created.worktreeRoot, "base-only.txt")), true);

			const reused = await setup({
				cwd: sourceCwd,
				gitWorktreeDir: "../goal-created-wt",
				baseBranch: "main",
			});

			assert.equal(reused.created, false);
			assert.equal(reused.worktreeRoot, created.worktreeRoot);
			assert.equal(reused.cwd, created.cwd);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an existing file instead of overwriting it", async () => {
		const { root, repo } = await createGitRepo();
		try {
			const partialRoot = join(root, "partial-wt");
			writeFileSync(partialRoot, "not a directory\n");
			await assert.rejects(
				() => setup({ cwd: repo, gitWorktreeDir: partialRoot, baseBranch: "main" }),
				/already exists but is not a directory/,
			);
			assert.equal(existsSync(partialRoot), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects the invoking checkout as a reusable worktree target", async () => {
		const { root, repo } = await createGitRepo();
		try {
			await assert.rejects(
				() => setup({ cwd: repo, gitWorktreeDir: repo, baseBranch: "main" }),
				/gitWorktreeDir must not resolve to the invoking checkout/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects reusable worktrees nested inside the invoking checkout", async () => {
		const { root, repo } = await createGitRepo();
		try {
			await assert.rejects(
				() => setup({ cwd: repo, gitWorktreeDir: join(repo, ".atomic", "nested-wt"), baseBranch: "main" }),
				/gitWorktreeDir must be outside the invoking checkout/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects missing worktrees whose symlinked parent resolves inside the invoking checkout", async () => {
		const { root, repo } = await createGitRepo();
		const alias = join(root, "repo-alias");
		symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
		try {
			await assert.rejects(
				() => setup({ cwd: repo, gitWorktreeDir: join(alias, "nested-wt"), baseBranch: "main" }),
				/gitWorktreeDir must be outside the invoking checkout/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses absolute git_worktree_dir paths as-is", async () => {
		const { root, repo } = await createGitRepo();
		try {
			const absoluteWorktree = join(root, "absolute-goal-wt");
			const created = await setup({
				cwd: repo,
				gitWorktreeDir: absoluteWorktree,
				baseBranch: "goal-base",
			});

			assert.equal(created.created, true);
			assert.equal(created.worktreeRoot, absoluteWorktree);
			assert.equal(created.cwd, absoluteWorktree);
			assert.equal(existsSync(join(absoluteWorktree, "base-only.txt")), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
