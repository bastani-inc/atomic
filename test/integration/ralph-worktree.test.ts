import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  WorkflowChainOptions,
  WorkflowParallelOptions,
  WorkflowRunContext,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowUIContext,
} from "../../packages/workflows/src/shared/types.js";

type RalphTestModule = {
  runRalphWorkflowFromCwd(
    ctx: WorkflowRunContext<Record<string, unknown>>,
    workflowStartCwd: string,
  ): Promise<Record<string, unknown>>;
};

interface MockCalls {
  readonly task: string[];
  readonly parallelOptions: WorkflowParallelOptions[];
  readonly taskOptions: Record<string, WorkflowTaskOptions[]>;
}

interface MockResponders {
  task?: (name: string, options: WorkflowTaskOptions, calls: MockCalls) => string | undefined;
  parallel?: (
    steps: readonly WorkflowTaskStep[],
    options: WorkflowParallelOptions,
    calls: MockCalls,
  ) => Promise<WorkflowTaskResult[] | undefined> | WorkflowTaskResult[] | undefined;
}

function promptText(options: WorkflowTaskOptions): string {
  return options.prompt ?? options.task ?? "";
}

function makeTaskResult(name: string, text: string): WorkflowTaskResult {
  return { name, stageName: name, text };
}

function makeMockCtx<TInputs extends Record<string, unknown>>(
  inputs: TInputs,
  responders: MockResponders = {},
): WorkflowRunContext<TInputs> & { calls: MockCalls } {
  const calls: MockCalls = {
    task: [],
    parallelOptions: [],
    taskOptions: {},
  };

  const ui: WorkflowUIContext = {
    input: async (prompt: string) => `mock-input:${prompt.slice(0, 20)}`,
    confirm: async () => false,
    select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
    editor: async (initial?: string) => initial ?? "mock-editor-content",
  };

  const runTask = async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
    calls.task.push(name);
    calls.taskOptions[name] = [...(calls.taskOptions[name] ?? []), options];
    const text = promptText(options);
    const override = responders.task?.(name, options, calls);
    return makeTaskResult(name, override ?? `[mock-task:${name}] ${text.slice(0, 80)}`);
  };

  return {
    inputs,
    calls,
    stage: (name: string) => {
      throw new Error(`ctx.stage should not be used by builtin workflow ${name}`);
    },
    task: runTask,
    chain: async (
      steps: readonly WorkflowTaskStep[],
      _options?: WorkflowChainOptions,
    ): Promise<WorkflowTaskResult[]> => {
      const results: WorkflowTaskResult[] = [];
      for (const step of steps) {
        results.push(await runTask(step.name, step));
      }
      return results;
    },
    parallel: async (
      steps: readonly WorkflowTaskStep[],
      options: WorkflowParallelOptions = {},
    ): Promise<WorkflowTaskResult[]> => {
      calls.parallelOptions.push(options);
      const override = await responders.parallel?.(steps, options, calls);
      if (override !== undefined) return override;
      return Promise.all(steps.map((step) => runTask(step.name, step)));
    },
    ui,
  };
}

describe("ralph git worktree integration", () => {
  let tempRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "atomic-ralph-integration-"));
  });

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function requireTempRoot(): string {
    if (tempRoot === undefined) throw new Error("expected Ralph integration temp root");
    return tempRoot;
  }

  function assertRalphResultShape(result: Record<string, unknown>, artifactRoot: string): void {
    assert.equal(typeof result["result"], "string");
    assert.equal(typeof result["plan"], "string");
    assert.equal(typeof result["plan_path"], "string");
    assert.ok(String(result["plan_path"]).startsWith(join(artifactRoot, "specs")));
    assert.equal(typeof result["implementation_notes_path"], "string");
    assert.equal(typeof result["pr_report"], "string");
    assert.equal(typeof result["approved"], "boolean");
    assert.equal(typeof result["iterations_completed"], "number");
    assert.equal(typeof result["review_report"], "string");
  }

  function initializeGitRepository(name = "repo"): string {
    const repo = join(requireTempRoot(), name);
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# test repo\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    return repo;
  }

  function assertSamePath(actual: string | undefined, expected: string | undefined, message: string): void {
    if (actual === undefined || expected === undefined) {
      assert.equal(actual, expected, message);
      return;
    }
    assert.equal(canonicalPathForComparison(actual), canonicalPathForComparison(expected), message);
  }

  function assertEveryRalphStageCwd(
    ctx: { readonly calls: MockCalls },
    expectedCwd: string | undefined,
  ): void {
    for (const [taskName, entries] of Object.entries(ctx.calls.taskOptions)) {
      for (const options of entries) {
        assertSamePath(options.cwd, expectedCwd, `unexpected cwd for ${taskName}`);
      }
    }
    for (const options of ctx.calls.parallelOptions) {
      assertSamePath(options.cwd, expectedCwd, "unexpected cwd for parallel stage");
    }
  }

  function canonicalPathForComparison(path: string): string {
    let canonical = path;
    try {
      canonical = realpathSync.native(path);
    } catch {
      try {
        canonical = join(realpathSync.native(dirname(path)), basename(path));
      } catch {
        canonical = path;
      }
    }
    const normalized = canonical.replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  function assertWorktreeRegistered(_repo: string, worktreePath: string): void {
    assert.equal(existsSync(join(worktreePath, ".git")), true, "expected git worktree checkout");
    assert.equal(
      execFileSync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]).toString().trim(),
      "true",
      "expected git to recognize the worktree checkout",
    );
  }

  function addDetachedWorktree(repo: string, worktreePath: string): void {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "main"], { cwd: repo, stdio: "ignore" });
  }

  test("creates a relative git_worktree_dir from repo root and leaves it after success", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const subdir = join(repo, "nested");
    mkdirSync(subdir, { recursive: true });
    const expectedWorktree = join(repo, "worktrees", "ralph");
    const ctx = makeMockCtx(
      {
        prompt: "Add a small feature",
        max_loops: 1,
        base_branch: "main",
        git_worktree_dir: join("worktrees", "ralph"),
      },
      {
        task: (name, options) => {
          if (name === "planner-1") {
            assertSamePath(options.cwd, expectedWorktree, "expected planner to run from worktree");
            assertWorktreeRegistered(repo, expectedWorktree);
            assert.equal(
              execFileSync("git", ["-C", expectedWorktree, "rev-parse", "HEAD"]).toString().trim(),
              execFileSync("git", ["-C", repo, "rev-parse", "main"]).toString().trim(),
            );
          }
          return undefined;
        },
      },
    );

    const result = await mod.runRalphWorkflowFromCwd(ctx, subdir);

    assertRalphResultShape(result, subdir);
    const planPath = String(result["plan_path"]);
    assert.equal(planPath.startsWith(expectedWorktree), false);
    const orchestratorReads = ctx.calls.taskOptions["orchestrator-1"]?.[0]?.reads;
    assert.ok(Array.isArray(orchestratorReads) && orchestratorReads.includes(planPath));
    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("fails fast outside a git repo when git_worktree_dir is requested", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const requestedWorktree = join(requireTempRoot(), "outside-repo-worktree");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: requestedWorktree,
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, requireTempRoot()),
      /git_worktree_dir requires Ralph to be invoked from inside a Git repository/,
    );
    assert.deepEqual(ctx.calls.task, []);
    assert.equal(existsSync(requestedWorktree), false);
  });

  test("creates an absolute git_worktree_dir and leaves it after success", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "absolute-worktrees", "ralph");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: expectedWorktree,
    });

    await mod.runRalphWorkflowFromCwd(ctx, repo);

    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("reuses an existing git worktree in its current state", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "existing-worktree");
    addDetachedWorktree(repo, expectedWorktree);
    const uncommittedPath = join(expectedWorktree, "uncommitted.txt");
    writeFileSync(uncommittedPath, "keep me\n", "utf8");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "missing-branch",
      git_worktree_dir: expectedWorktree,
    });

    await mod.runRalphWorkflowFromCwd(ctx, repo);

    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assert.equal(existsSync(uncommittedPath), true);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("fails fast when existing git_worktree_dir is a worktree from another repository", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository("repo");
    const otherRepo = initializeGitRepository("other-repo");
    const foreignWorktree = join(requireTempRoot(), "foreign-worktree");
    addDetachedWorktree(otherRepo, foreignWorktree);
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: foreignWorktree,
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, repo),
      /git_worktree_dir already exists but does not belong to the invoking Git repository/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("fails fast when existing git_worktree_dir is another repository checkout", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository("repo");
    const otherRepo = initializeGitRepository("other-repo");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: otherRepo,
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, repo),
      /git_worktree_dir already exists but does not belong to the invoking Git repository/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("can re-run with the same git_worktree_dir without cleanup", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "repeat-worktree");

    const firstCtx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: expectedWorktree,
    });
    const secondCtx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: expectedWorktree,
    });

    await mod.runRalphWorkflowFromCwd(firstCtx, repo);
    assertWorktreeRegistered(repo, expectedWorktree);
    await mod.runRalphWorkflowFromCwd(secondCtx, repo);

    assertEveryRalphStageCwd(firstCtx, expectedWorktree);
    assertEveryRalphStageCwd(secondCtx, expectedWorktree);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("fails fast when base_branch does not exist for a missing worktree path", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const requestedWorktree = join(requireTempRoot(), "missing-base-worktree");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "missing-branch",
      git_worktree_dir: requestedWorktree,
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, repo),
      /Failed to create git worktree at requested git_worktree_dir/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("fails fast when requested git_worktree_dir is a non-empty non-git directory", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const requestedWorktree = join(requireTempRoot(), "non-empty-directory");
    mkdirSync(requestedWorktree, { recursive: true });
    writeFileSync(join(requestedWorktree, "README.md"), "already here\n", "utf8");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: requestedWorktree,
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, repo),
      /git_worktree_dir already exists but is not a Git worktree/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("fails fast when git_worktree_dir is unusable", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: "invalid\0path",
    });

    await assert.rejects(
      () => mod.runRalphWorkflowFromCwd(ctx, repo),
      /git_worktree_dir contains an unusable null byte/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("propagates worktree cwd across multiple iterations", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "multi-iteration-worktree");
    const ctx = makeMockCtx(
      {
        prompt: "Add a small feature",
        max_loops: 2,
        base_branch: "main",
        git_worktree_dir: expectedWorktree,
      },
      {
        parallel: (steps) => {
          if (steps.some((step) => step.name.startsWith("reviewer-"))) {
            return steps.map((step) => makeTaskResult(step.name, JSON.stringify({
              findings: [{
                title: "[P2] Continue first pass",
                body: "Force a second iteration for cwd coverage.",
                confidence_score: 0.9,
                code_location: { absolute_file_path: join(repo, "README.md"), line_range: { start: 1, end: 1 } },
              }],
              overall_correctness: "patch is incorrect",
              overall_explanation: "continue",
              overall_confidence_score: 0.9,
              stop_review_loop: false,
              reviewer_error: null,
            })));
          }
          return undefined;
        },
      },
    );

    await mod.runRalphWorkflowFromCwd(ctx, repo);

    for (const name of ["planner-1", "orchestrator-1", "code-simplifier-1", "planner-2", "orchestrator-2", "code-simplifier-2"]) {
      assertSamePath(ctx.calls.taskOptions[name]?.[0]?.cwd, expectedWorktree, `unexpected cwd for ${name}`);
    }
    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("leaves the worktree for recovery when the workflow fails", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "failed-run-worktree");
    const ctx = makeMockCtx(
      {
        prompt: "Add a small feature",
        max_loops: 1,
        base_branch: "main",
        git_worktree_dir: expectedWorktree,
      },
      {
        task: (name) => {
          if (name === "planner-1") throw new Error("planner failed");
          return undefined;
        },
      },
    );

    await assert.rejects(() => mod.runRalphWorkflowFromCwd(ctx, repo), /planner failed/);

    assertWorktreeRegistered(repo, expectedWorktree);
  });
});
