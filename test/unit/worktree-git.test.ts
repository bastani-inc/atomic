import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitWorktreeSetupCache,
  gitFailureMessage,
  runGitChecked,
  setupGitWorktree,
  withGitRunnerForTest,
  type GitRunner,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import type { GitResult } from "../../packages/workflows/src/runs/shared/worktree-types.js";
import { createGitWorktreeSetupCacheOwner } from "../../packages/workflows/src/runs/shared/worktree-cache-lifecycle.js";

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

function createGitRepository(): { readonly root: string; readonly repo: string; readonly worktree: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-generation-test-")));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo);
  runGitChecked(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "primary\n");
  runGitChecked(repo, ["add", "."]);
  runGitChecked(repo, [
    "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
    "commit", "--no-gpg-sign", "-m", "initial",
  ]);
  return { root, repo, worktree };
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
    const worktree = join(root, "transient-wt");
    const commonDir = join(root, "common.git");
    mkdirSync(commonDir);
    let sourceTopLevelCalls = 0;
    const runner: GitRunner = (cwd, args) => {
      if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
        if (cwd === sourceCwd) {
          sourceTopLevelCalls += 1;
          return sourceTopLevelCalls === 1 ? timedOutGit() : successfulGit(`${repo}\n`);
        }
        return successfulGit(`${worktree}\n`);
      }
      if (isArgs(args, ["rev-parse", "--git-common-dir"])) return successfulGit(`${commonDir}\n`);
      if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) {
        mkdirSync(worktree);
        return successfulGit();
      }
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
      assert.equal(sourceTopLevelCalls, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caches setup and revalidates checkout identity within a run", () => {
    const { root, repo, sourceCwd } = createRepoShape();
    const worktree = join(root, "cached-wt");
    const commonDir = join(root, "common.git");
    const worktreeGitDir = join(root, "cached-wt.git");
    mkdirSync(commonDir);
    mkdirSync(worktreeGitDir);
    let worktreeAddCalls = 0;
    let identityProbeCalls = 0;
    const runner: GitRunner = (cwd, args) => {
      if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
        return successfulGit(`${cwd === sourceCwd ? repo : worktree}\n`);
      }
      if (isArgs(args, ["rev-parse", "--git-common-dir"])) {
        identityProbeCalls += 1;
        return successfulGit(`${commonDir}\n`);
      }
      if (isArgs(args, ["rev-parse", "--absolute-git-dir"])) {
        identityProbeCalls += 1;
        return successfulGit(`${worktreeGitDir}\n`);
      }
      if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) {
        worktreeAddCalls += 1;
        mkdirSync(worktree);
        writeFileSync(join(worktree, ".git"), "gitdir: ../cached-wt.git\n");
        return successfulGit();
      }
      return failingGit(args);
    };

    const cache = createGitWorktreeSetupCache();
    try {
      withGitRunnerForTest(runner, () => {
        const options = { cwd: sourceCwd, gitWorktreeDir: "../cached-wt", baseBranch: "main" };
        const setup = cache.get(options);
        assert.equal(setup.cwd, join(root, "cached-wt", "packages", "api"));
        assert.equal(cache.get(options), setup);
      });
      assert.equal(worktreeAddCalls, 1);
      assert.ok(identityProbeCalls > 0, "cache reuse should probe the selected checkout identity");
    } finally {
      cache.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects cache reuse when a byte-identical .git file replaces the cached checkout generation", () => {
    const { root, repo, worktree } = createGitRepository();
    const cache = createGitWorktreeSetupCache();
    try {
      cache.get({ cwd: repo, gitWorktreeDir: worktree });
      const before = statSync(worktree);
      const gitFile = join(worktree, ".git");
      const gitFileContents = readFileSync(gitFile);

      renameSync(gitFile, `${gitFile}.replaced`);
      writeFileSync(gitFile, gitFileContents);

      const after = statSync(worktree);
      assert.equal(after.dev, before.dev, "replacement should retain the cached root device");
      assert.equal(after.ino, before.ino, "replacement should retain the cached root inode");
      assert.throws(
        () => cache.get({ cwd: repo, gitWorktreeDir: worktree }),
        /Cached gitWorktreeDir changed before reuse:/,
      );
    } finally {
      cache.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("disposes cached checkout anchors idempotently before worktree cleanup", () => {
    const { root, repo, worktree } = createGitRepository();
    const cache = createGitWorktreeSetupCache();
    try {
      cache.get({ cwd: repo, gitWorktreeDir: worktree });
      cache.dispose();
      assert.doesNotThrow(() => cache.dispose());
      assert.throws(
        () => cache.get({ cwd: repo, gitWorktreeDir: worktree }),
        /cache is already disposed/,
      );
      runGitChecked(repo, ["worktree", "remove", "--force", worktree]);
    } finally {
      cache.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a supplied setup cache open when its engine owner is released", () => {
    const { root, repo, worktree } = createGitRepository();
    const cache = createGitWorktreeSetupCache();
    const owner = createGitWorktreeSetupCacheOwner(cache);
    let finalized = false;
    try {
      owner.release(() => { finalized = true; });
      assert.equal(finalized, true);
      assert.equal(cache.get({ cwd: repo, gitWorktreeDir: worktree }).worktreeRoot, worktree);
    } finally {
      cache.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports the main checkout as a reusable target from a linked invocation", () => {
    const { root, repo } = createGitRepository();
    const linkedSource = join(root, "linked-source");
    const cache = createGitWorktreeSetupCache();
    try {
      runGitChecked(repo, ["worktree", "add", "--detach", linkedSource]);
      const options = { cwd: linkedSource, gitWorktreeDir: repo };
      const setup = cache.get(options);
      assert.equal(setup.created, false);
      assert.equal(setup.worktreeRoot, repo);
      assert.equal(cache.get(options), setup);
    } finally {
      cache.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
