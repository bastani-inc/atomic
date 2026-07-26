import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goal from "../../packages/workflows/builtin/goal.js";
import { gitFailureMessage, gitTopLevelFromResult, isGitTimeoutResult, setupGitWorktree, runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";

function createGitRepo(): { readonly root: string; readonly repo: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-goal-worktree-test-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGitChecked(repo, ["init", "-b", "main"]);
  runGitChecked(repo, ["config", "user.email", "test@example.com"]);
  runGitChecked(repo, ["config", "user.name", "Test User"]);
  runGitChecked(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "main\n");
  runGitChecked(repo, ["add", "README.md"]);
  runGitChecked(repo, ["commit", "-m", "initial"]);
  runGitChecked(repo, ["checkout", "-b", "goal-base"]);
  writeFileSync(join(repo, "base-only.txt"), "created from base branch\n");
  runGitChecked(repo, ["add", "base-only.txt"]);
  runGitChecked(repo, ["commit", "-m", "base marker"]);
  runGitChecked(repo, ["checkout", "main"]);
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
      () => gitTopLevelFromResult({ stdout: "", stderr: "", status: null, error }, "/tmp/reused-wt", "gitWorktreeDir /tmp/reused-wt"),
      /Timed out while validating gitWorktreeDir \/tmp\/reused-wt.*ETIMEDOUT/,
    );
  });

  test("creates missing relative worktrees from base_branch and reuses existing ones", () => {
    const { root, repo } = createGitRepo();
    try {
      const sourceCwd = join(repo, "packages", "api");
      const created = setupGitWorktree({
        cwd: sourceCwd,
        gitWorktreeDir: "../goal-created-wt",
        baseBranch: "goal-base",
      });

      assert.equal(created.created, true);
      assert.equal(created.worktreeRoot, join(root, "goal-created-wt"));
      assert.equal(created.cwd, join(root, "goal-created-wt", "packages", "api"));
      assert.equal(existsSync(join(created.worktreeRoot, "base-only.txt")), true);

      const reused = setupGitWorktree({
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

  test("rejects existing non-worktree roots instead of overwriting partial directories", () => {
    const { root, repo } = createGitRepo();
    try {
      const partialRoot = join(root, "partial-wt");
      mkdirSync(partialRoot);
      assert.throws(
        () => setupGitWorktree({ cwd: repo, gitWorktreeDir: partialRoot, baseBranch: "main" }),
        /already exists but is not a Git worktree/,
      );
      assert.equal(existsSync(partialRoot), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects the invoking checkout as a reusable worktree target", () => {
    const { root, repo } = createGitRepo();
    try {
      assert.throws(
        () => setupGitWorktree({ cwd: repo, gitWorktreeDir: repo, baseBranch: "main" }),
        /gitWorktreeDir must not resolve to the invoking checkout/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects reusable worktrees nested inside the invoking checkout", () => {
    const { root, repo } = createGitRepo();
    try {
      assert.throws(
        () => setupGitWorktree({ cwd: repo, gitWorktreeDir: join(repo, ".atomic", "nested-wt"), baseBranch: "main" }),
        /gitWorktreeDir must be outside the invoking checkout/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing worktrees whose symlinked parent resolves inside the invoking checkout", () => {
    const { root, repo } = createGitRepo();
    const alias = join(root, "repo-alias");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(
        () => setupGitWorktree({ cwd: repo, gitWorktreeDir: join(alias, "nested-wt"), baseBranch: "main" }),
        /gitWorktreeDir must be outside the invoking checkout/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses absolute git_worktree_dir paths as-is", () => {
    const { root, repo } = createGitRepo();
    try {
      const absoluteWorktree = join(root, "absolute-goal-wt");
      const created = setupGitWorktree({
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
