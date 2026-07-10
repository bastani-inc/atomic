import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitWorktreeSetupCache,
  gitFailureMessage,
  setupGitWorktree,
  withGitRunnerForTest,
  type GitRunner,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import type { GitResult } from "../../packages/workflows/src/runs/shared/worktree-types.js";

function successfulGit(stdout = ""): GitResult {
  return { stdout, stderr: "", status: 0, signal: null, elapsedMs: 1 };
}

function timedOutGit(): GitResult {
  const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
  return { stdout: "", stderr: "", status: null, signal: null, elapsedMs: 60_001, error };
}

function failingGit(args: readonly string[]): GitResult {
  return { stdout: "", stderr: `unexpected fake git call: ${args.join(" ")}`, status: 1, signal: null, elapsedMs: 1 };
}

function createRepoShape(): { readonly root: string; readonly repo: string; readonly sourceCwd: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-git-test-")));
  const repo = join(root, "repo");
  const sourceCwd = join(repo, "packages", "api");
  mkdirSync(sourceCwd, { recursive: true });
  return { root, repo, sourceCwd };
}

function isArgs(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((value, index) => value === expected[index]);
}

describe("workflow reusable git worktree git runner", () => {
  test("formats timeout diagnostics with command cwd timeout elapsed status and signal", () => {
    const message = gitFailureMessage({
      ...timedOutGit(),
      argv: ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      cwd: "/repo with spaces",
      timeoutMs: 60_000,
      elapsedMs: 60_123,
    });

    assert.match(message, /git command timed out after 60000ms \(ETIMEDOUT\)/);
    assert.match(message, /command: git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false rev-parse --show-toplevel/);
    assert.match(message, /cwd: \/repo with spaces/);
    assert.match(message, /timeout: 60000ms/);
    assert.match(message, /elapsed: 60123ms/);
    assert.match(message, /status: null/);
    assert.match(message, /signal: null/);
  });

  test("retries transient rev-parse timeouts before creating a missing worktree", () => {
    const { root, repo, sourceCwd } = createRepoShape();
    const calls: Array<{ readonly cwd: string; readonly args: readonly string[] }> = [];
    let showTopLevelCalls = 0;
    const runner: GitRunner = (cwd, args) => {
      calls.push({ cwd, args: [...args] });
      if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
        showTopLevelCalls += 1;
        return showTopLevelCalls === 1 ? timedOutGit() : successfulGit(`${repo}\n`);
      }
      if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) return successfulGit();
      return failingGit(args);
    };

    try {
      const setup = withGitRunnerForTest(runner, () => setupGitWorktree({
        cwd: sourceCwd,
        gitWorktreeDir: "../transient-wt",
        baseBranch: "main",
      }));

      assert.equal(setup.created, true);
      assert.equal(setup.repositoryRoot, repo);
      assert.equal(setup.worktreeRoot, join(root, "transient-wt"));
      assert.equal(setup.cwd, join(root, "transient-wt", "packages", "api"));
      assert.equal(showTopLevelCalls, 2);
      assert.deepEqual(calls.map((call) => call.args), [
        ["rev-parse", "--show-toplevel"],
        ["rev-parse", "--show-toplevel"],
        ["worktree", "add", "--detach", join(root, "transient-wt"), "main"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caches repeated workflow input worktree setup within a run", () => {
    const { root, repo, sourceCwd } = createRepoShape();
    let showTopLevelCalls = 0;
    let worktreeAddCalls = 0;
    const runner: GitRunner = (_cwd, args) => {
      if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
        showTopLevelCalls += 1;
        return successfulGit(`${repo}\n`);
      }
      if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) {
        worktreeAddCalls += 1;
        return successfulGit();
      }
      return failingGit(args);
    };

    try {
      const cache = createGitWorktreeSetupCache();
      withGitRunnerForTest(runner, () => {
        const options = { cwd: sourceCwd, gitWorktreeDir: "../cached-wt", baseBranch: "main" };
        const setup = cache.get(options);
        assert.equal(setup.cwd, join(root, "cached-wt", "packages", "api"));
        assert.equal(cache.get(options), setup);
      });
      assert.equal(showTopLevelCalls, 1);
      assert.equal(worktreeAddCalls, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
