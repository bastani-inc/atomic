import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGitRefInput } from "../../packages/workflows/src/runs/shared/git-ref.js";
import { setupGitWorktree } from "../../packages/workflows/src/runs/shared/worktree.js";

const GIT_LOCAL_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function gitCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
  return env;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: gitCommandEnv(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout.trim();
}

async function initializeGitRepository(repo: string): Promise<void> {
  await runGit(repo, ["init"]);
  await runGit(repo, ["config", "user.name", "Atomic Test"]);
  await runGit(repo, ["config", "user.email", "atomic-test@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "baseline\n", "utf8");
  await runGit(repo, ["add", "."]);
  await runGit(repo, ["commit", "--no-gpg-sign", "-m", "baseline"]);
  await runGit(repo, ["branch", "-M", "main"]);
}

async function addLinkedWorktree(repo: string, worktree: string): Promise<void> {
  await runGit(repo, ["worktree", "add", "--detach", worktree, "main"]);
}

const INVOKING_CHECKOUT_REJECTION = /separate reusable Git worktree root|invoking checkout/;
const DIRTY_WORKTREE_REJECTION = /not clean|dirty|tracked|untracked|ignored/i;

describe("normalizeGitRefInput", () => {
  test("preserves common safe refs unchanged", () => {
    for (const ref of ["main", "feature/foo", "v1.0"] as const) {
      assert.equal(normalizeGitRefInput(ref, "origin/main"), ref);
    }
  });

  test("falls back for unsafe or malformed refs", () => {
    for (const ref of [
      "",
      "   ",
      "-main",
      "..",
      "feature//foo",
      "foo.lock",
      "main; echo pwn",
      "topic@{1}",
    ] as const) {
      assert.equal(normalizeGitRefInput(ref, "origin/main"), "origin/main", ref);
    }
  });
});

describe("setupGitWorktree", () => {
  test("rejects the invoking checkout as gitWorktreeDir", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-primary-reject-"));
    try {
      const repo = join(tempRoot, "repo");
      const nested = join(repo, "packages", "api");
      mkdirSync(nested, { recursive: true });
      await initializeGitRepository(repo);

      for (const [cwd, gitWorktreeDir] of [
        [repo, "."],
        [repo, repo],
        [nested, "."],
      ] as const) {
        assert.throws(() =>
          setupGitWorktree({
            cwd,
            gitWorktreeDir,
            baseBranch: "main",
          }), INVOKING_CHECKOUT_REJECTION);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects missing descendants of the invoking checkout before creating directories", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-nested-reject-"));
    try {
      const repo = join(tempRoot, "repo");
      mkdirSync(repo);
      await initializeGitRepository(repo);

      for (const gitWorktreeDir of [".descent-wt", join("packages", "api", ".descent-wt")] as const) {
        assert.throws(() =>
          setupGitWorktree({
            cwd: repo,
            gitWorktreeDir,
            baseBranch: "main",
          }), INVOKING_CHECKOUT_REJECTION, gitWorktreeDir);
      }

      assert.equal(await runGit(repo, ["status", "--short", "--untracked-files=all"]), "");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("allows missing sibling reusable worktree paths outside the invoking checkout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-sibling-allow-"));
    try {
      const repo = join(tempRoot, "repo");
      mkdirSync(repo);
      await initializeGitRepository(repo);

      const result = setupGitWorktree({
        cwd: repo,
        gitWorktreeDir: "../sibling-worktree",
        baseBranch: "main",
      });

      assert.equal(result.created, true);
      assert.equal(result.worktreeRoot, join(tempRoot, "sibling-worktree"));
      assert.equal(result.cwd, join(tempRoot, "sibling-worktree"));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("ignores inherited Git hook index environment when creating worktrees", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-hook-env-"));
    const previousIndexFile = process.env.GIT_INDEX_FILE;
    try {
      const repo = join(tempRoot, "repo");
      mkdirSync(repo);
      await initializeGitRepository(repo);

      process.env.GIT_INDEX_FILE = ".git/index";
      const result = setupGitWorktree({
        cwd: repo,
        gitWorktreeDir: "../hook-env-worktree",
        baseBranch: "main",
      });

      assert.equal(result.created, true);
      assert.equal(result.worktreeRoot, join(tempRoot, "hook-env-worktree"));
    } finally {
      if (previousIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousIndexFile;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects a symlink resolving to the invoking checkout as gitWorktreeDir", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-primary-symlink-"));
    try {
      const repo = join(tempRoot, "repo");
      const repoLink = join(tempRoot, "repo-link");
      mkdirSync(repo);
      await initializeGitRepository(repo);
      symlinkSync(repo, repoLink, "dir");

      assert.throws(() =>
        setupGitWorktree({
          cwd: repo,
          gitWorktreeDir: repoLink,
          baseBranch: "main",
        }), INVOKING_CHECKOUT_REJECTION);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects missing descendants reached through a symlink to the invoking checkout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-symlink-descendant-"));
    try {
      const repo = join(tempRoot, "repo");
      const repoLink = join(tempRoot, "repo-link");
      mkdirSync(repo);
      await initializeGitRepository(repo);
      symlinkSync(repo, repoLink, "dir");

      assert.throws(() =>
        setupGitWorktree({
          cwd: repo,
          gitWorktreeDir: join(repoLink, ".descent-wt"),
          baseBranch: "main",
        }), INVOKING_CHECKOUT_REJECTION);
      assert.equal(existsSync(join(repo, ".descent-wt")), false);
      assert.equal(await runGit(repo, ["status", "--short", "--untracked-files=all"]), "");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects dirty existing reusable worktrees before reuse", async () => {
    const dirtyCases = [
      {
        name: "tracked modification",
        dirty: async (worktree: string) => {
          writeFileSync(join(worktree, "tracked.txt"), "dirty tracked\n", "utf8");
        },
      },
      {
        name: "staged change",
        dirty: async (worktree: string) => {
          writeFileSync(join(worktree, "tracked.txt"), "dirty staged\n", "utf8");
          await runGit(worktree, ["add", "tracked.txt"]);
        },
      },
      {
        name: "untracked file",
        dirty: async (worktree: string) => {
          writeFileSync(join(worktree, "untracked.txt"), "scratch\n", "utf8");
        },
      },
      {
        name: "ignored file",
        dirty: async (worktree: string) => {
          writeFileSync(join(worktree, ".gitignore"), "ignored.log\n", "utf8");
          await runGit(worktree, ["add", ".gitignore"]);
          await runGit(worktree, ["commit", "--no-gpg-sign", "-m", "add ignore rules"]);
          writeFileSync(join(worktree, "ignored.log"), "generated\n", "utf8");
        },
      },
    ] as const;

    for (const dirtyCase of dirtyCases) {
      const tempRoot = mkdtempSync(join(tmpdir(), `atomic-worktree-dirty-${dirtyCase.name.replace(/\s+/g, "-")}-`));
      try {
        const repo = join(tempRoot, "repo");
        const worktree = join(tempRoot, "linked-worktree");
        mkdirSync(repo);
        await initializeGitRepository(repo);
        await addLinkedWorktree(repo, worktree);
        await dirtyCase.dirty(worktree);

        assert.throws(() =>
          setupGitWorktree({
            cwd: repo,
            gitWorktreeDir: worktree,
            baseBranch: "main",
          }), DIRTY_WORKTREE_REJECTION, dirtyCase.name);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  test("reuses a clean existing linked worktree", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-clean-reuse-"));
    try {
      const repo = join(tempRoot, "repo");
      const worktree = join(tempRoot, "linked-worktree");
      mkdirSync(repo);
      await initializeGitRepository(repo);
      await addLinkedWorktree(repo, worktree);

      const result = setupGitWorktree({
        cwd: repo,
        gitWorktreeDir: worktree,
        baseBranch: "main",
      });

      assert.equal(result.created, false);
      assert.equal(result.cwd, worktree);
      assert.equal(result.worktreeRoot, worktree);
      assert.equal(result.repositoryRoot, repo);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("sanitizes invalid baseBranch with HEAD fallback before git worktree add", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "atomic-worktree-base-ref-"));
    try {
      const repo = join(tempRoot, "repo");
      const worktree = join(tempRoot, "worktree");
      mkdirSync(repo);
      await initializeGitRepository(repo);
      const expectedHead = await runGit(repo, ["rev-parse", "HEAD"]);

      const result = setupGitWorktree({
        cwd: repo,
        gitWorktreeDir: worktree,
        baseBranch: "main; echo pwn",
      });

      assert.equal(result.created, true);
      assert.equal(result.cwd, worktree);
      assert.equal(await runGit(worktree, ["rev-parse", "HEAD"]), expectedHead);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
