import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";

function createGitRepo(name: string): { readonly root: string; readonly repo: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), name)));
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGitChecked(repo, ["init", "-b", "main"]);
  runGitChecked(repo, ["config", "user.email", "test@example.com"]);
  runGitChecked(repo, ["config", "user.name", "Test User"]);
  runGitChecked(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "main\n");
  runGitChecked(repo, ["add", "README.md"]);
  runGitChecked(repo, ["commit", "-m", "initial"]);
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  return { root, repo };
}

function makeRegistryWith(def: WorkflowDefinition): WorkflowRegistry {
  return {
    register: () => makeRegistryWith(def),
    merge: () => makeRegistryWith(def),
    get: (name: string) => (name === def.name || name === def.normalizedName ? def : undefined),
    has: (name: string) => name === def.name || name === def.normalizedName,
    remove: () => makeRegistryWith(def),
    names: () => [def.normalizedName],
    all: () => [def],
  };
}

describe("durable resume with reusable git worktrees", () => {
  let backend: InMemoryDurableBackend;
  let store: ReturnType<typeof createStore>;
  let cancellation: ReturnType<typeof createCancellationRegistry>;
  let jobs: ReturnType<typeof createJobTracker>;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    store = createStore();
    cancellation = createCancellationRegistry();
    jobs = createJobTracker();
  });

  afterEach(() => {
    setDurableBackend(undefined);
  });

  function depsFor(def: WorkflowDefinition) {
    return {
      registry: makeRegistryWith(def),
      baseRunOpts: { store, cancellation, jobs },
      durableBackend: backend,
    };
  }

  test("resumes input-bound reusable git worktrees from the original invocation cwd", async () => {
    const primary = createGitRepo("durable-worktree-primary-");
    const other = createGitRepo("durable-worktree-other-");
    try {
      const sourceCwd = join(primary.repo, "packages", "api");
      const expectedWorktree = join(primary.root, "resume-reused-wt");
      const expectedWorkflowCwd = join(expectedWorktree, "packages", "api");
      const wrongWorktree = join(other.root, "resume-reused-wt");
      const def = workflow({
        name: "worktree-resume-pipeline",
        description: "",
        inputs: { git_worktree_dir: Type.String() },
        outputs: { observed_cwd: Type.String() },
        worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
        run: async (ctx) => {
          const observed_cwd = ctx.cwd ?? "";
          await ctx.stage("observe-cwd").complete("ok");
          return { observed_cwd };
        },
      }) as unknown as WorkflowDefinition;
      backend.registerWorkflow({
        workflowId: "wf-worktree-resume",
        name: "worktree-resume-pipeline",
        inputs: { git_worktree_dir: "../resume-reused-wt" },
        createdAt: 1,
        status: "failed",
        completedCheckpoints: 1,
        invocationCwd: sourceCwd,
      });
      const baseRunOpts = {
        store,
        cancellation,
        jobs,
        cwd: other.repo,
        adapters: { complete: { complete: async (text: string) => text } },
      };

      const result = await resumeDurableWorkflow("wf-worktree-resume", { ...depsFor(def), baseRunOpts });

      assert.equal(result.ok, true);
      await jobs.get("wf-worktree-resume")?.promise;
      const run = store.runs().find((snapshot) => snapshot.id === "wf-worktree-resume");
      assert.equal(run?.status, "completed");
      assert.equal(run?.result?.observed_cwd, expectedWorkflowCwd);
      assert.equal(existsSync(expectedWorktree), true);
      assert.equal(existsSync(wrongWorktree), false);
      const handle = backend.getWorkflow("wf-worktree-resume");
      assert.equal(handle?.invocationCwd, sourceCwd);
      assert.equal(handle?.workflowCwd, expectedWorkflowCwd);
      assert.equal(handle?.gitWorktreeRoot, expectedWorktree);
    } finally {
      rmSync(primary.root, { recursive: true, force: true });
      rmSync(other.root, { recursive: true, force: true });
    }
  });

  test("returns resumed reusable worktree setup failures before claiming admission and restores resumability", async () => {
    const primary = createGitRepo("durable-worktree-partial-");
    const other = createGitRepo("durable-worktree-partial-other-");
    try {
      const sourceCwd = join(primary.repo, "packages", "api");
      mkdirSync(join(primary.root, "partial-wt"));
      const def = workflow({
        name: "worktree-partial-fails",
        description: "",
        inputs: { git_worktree_dir: Type.String() },
        outputs: { ok: Type.Optional(Type.Boolean()) },
        worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
        run: async (ctx) => {
          await ctx.stage("unreached").complete("ok");
          return { ok: true };
        },
      }) as unknown as WorkflowDefinition;
      backend.registerWorkflow({
        workflowId: "wf-worktree-partial-fails",
        name: "worktree-partial-fails",
        inputs: { git_worktree_dir: "../partial-wt" },
        createdAt: 1,
        status: "failed",
        completedCheckpoints: 1,
        invocationCwd: sourceCwd,
        resumable: true,
      });
      const baseRunOpts = {
        store,
        cancellation,
        jobs,
        cwd: other.repo,
        adapters: { complete: { complete: async (text: string) => text } },
      };

      const result = await resumeDurableWorkflow("wf-worktree-partial-fails", { ...depsFor(def), baseRunOpts, jobs });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "startup_failed");
        assert.match(result.message, /already exists but is not a Git worktree/);
      }
      assert.equal(store.runs().some((snapshot) => snapshot.id === "wf-worktree-partial-fails"), false);
      assert.equal(jobs.has("wf-worktree-partial-fails"), false);
      assert.equal(cancellation.abort("wf-worktree-partial-fails"), false);
      assert.equal(backend.getWorkflow("wf-worktree-partial-fails")?.status, "failed");
      assert.equal(backend.getWorkflow("wf-worktree-partial-fails")?.resumable, true);

      rmSync(join(primary.root, "partial-wt"), { recursive: true, force: true });
      const retry = await resumeDurableWorkflow("wf-worktree-partial-fails", { ...depsFor(def), baseRunOpts, jobs });
      assert.equal(retry.ok, true);
      await jobs.get("wf-worktree-partial-fails")?.promise;
      assert.equal(store.runs().find((snapshot) => snapshot.id === "wf-worktree-partial-fails")?.status, "completed");
    } finally {
      rmSync(primary.root, { recursive: true, force: true });
      rmSync(other.root, { recursive: true, force: true });
    }
  });

  test("detached reusable worktree setup does not block accepted run handoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "durable-worktree-slow-git-"));
    const fakeBin = join(root, "bin");
    const cwd = join(root, "repo");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nsleep 1\necho fake git delayed >&2\nexit 1\n");
    chmodSync(join(fakeBin, "git"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    try {
      const def = workflow({
        name: "worktree-detached-handoff",
        description: "",
        inputs: { git_worktree_dir: Type.String() },
        outputs: { ok: Type.Optional(Type.Boolean()) },
        worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
        run: async (ctx) => {
          await ctx.stage("unreached").complete("ok");
          return { ok: true };
        },
      }) as unknown as WorkflowDefinition;

      const started = Date.now();
      const accepted = runDetached(def, { git_worktree_dir: "../slow-wt" }, {
        store,
        cancellation,
        jobs,
        cwd,
        durableBackend: backend,
        adapters: { complete: { complete: async (text: string) => text } },
      });
      const elapsedMs = Date.now() - started;

      assert.equal(accepted.status, "running");
      assert.ok(elapsedMs < 500, `runDetached blocked for ${elapsedMs}ms before accepting the run`);
      await jobs.get(accepted.runId)?.promise;
      const run = store.runs().find((snapshot) => snapshot.id === accepted.runId);
      assert.equal(run?.status, "failed");
      assert.match(run?.error ?? "", /gitWorktreeDir requires the workflow to be invoked from inside a Git repository|fake git delayed/);
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
