import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setupGitWorktree } from "../../packages/workflows/src/index.js";
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
  default: {
    run(ctx: WorkflowRunContext<Record<string, unknown>>): Promise<Record<string, unknown>>;
  };
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

function ralphWorktreeDefaults(
  inputs: Record<string, unknown>,
  cwd: string | undefined,
): { cwd?: string } {
  if (typeof cwd !== "string") return {};
  const gitWorktreeDir = inputs["git_worktree_dir"];
  if (typeof gitWorktreeDir !== "string" || gitWorktreeDir.trim().length === 0) return {};
  const baseBranch = typeof inputs["base_branch"] === "string" ? inputs["base_branch"] : undefined;
  try {
    return { cwd: setupGitWorktree({ gitWorktreeDir, baseBranch, cwd }).cwd };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message
        .replaceAll("gitWorktreeDir", "git_worktree_dir")
        .replace("requires the workflow to be invoked", "requires Ralph to be invoked"));
    }
    throw error;
  }
}

function withRalphWorktreeDefaults<TOptions extends { readonly cwd?: string }>(
  inputs: Record<string, unknown>,
  worktreeSetupCwd: string | undefined,
  options: TOptions,
): TOptions {
  if (options.cwd !== undefined) return options;
  return { ...options, ...ralphWorktreeDefaults(inputs, worktreeSetupCwd) };
}

function workflowWorktreeSetupCwd(ctx: { readonly cwd?: string; readonly worktreeSetupCwd?: unknown }): string | undefined {
  return typeof ctx.worktreeSetupCwd === "string" ? ctx.worktreeSetupCwd : ctx.cwd;
}

function ralphWorkflowCwd(inputs: Record<string, unknown>, cwd: string): string {
  return ralphWorktreeDefaults(inputs, cwd).cwd ?? cwd;
}

async function runRalphModule(
  mod: RalphTestModule,
  ctx: WorkflowRunContext<Record<string, unknown>> & { readonly calls: MockCalls },
  cwd: string,
): Promise<Record<string, unknown>> {
  return await mod.default.run({
    ...ctx,
    cwd: ralphWorkflowCwd(ctx.inputs, cwd),
    worktreeSetupCwd: cwd,
  } as WorkflowRunContext<Record<string, unknown>>);
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

  const ctx = {
    inputs,
    calls,
    stage: (name: string) => {
      throw new Error(`ctx.stage should not be used by builtin workflow ${name}`);
    },
    async task(this: WorkflowRunContext<TInputs>, name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> {
      const taskOptions = withRalphWorktreeDefaults(inputs, workflowWorktreeSetupCwd(this), options);
      calls.task.push(name);
      calls.taskOptions[name] = [...(calls.taskOptions[name] ?? []), taskOptions];
      const text = promptText(taskOptions);
      const override = responders.task?.(name, taskOptions, calls);
      return makeTaskResult(name, override ?? `[mock-task:${name}] ${text.slice(0, 80)}`);
    },
    async chain(this: WorkflowRunContext<TInputs>, steps: readonly WorkflowTaskStep[], _options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]> {
      const results: WorkflowTaskResult[] = [];
      for (const step of steps) {
        results.push(await this.task(step.name, step));
      }
      return results;
    },
    async parallel(this: WorkflowRunContext<TInputs>, steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> {
      const worktreeSetupCwd = workflowWorktreeSetupCwd(this);
      const parallelOptions = withRalphWorktreeDefaults(inputs, worktreeSetupCwd, options);
      calls.parallelOptions.push(parallelOptions);
      const preparedSteps = steps.map((step) => withRalphWorktreeDefaults(inputs, worktreeSetupCwd, step));
      const override = await responders.parallel?.(preparedSteps, parallelOptions, calls);
      if (override !== undefined) return override;
      return Promise.all(preparedSteps.map((step) => this.task(step.name, step)));
    },
    ui,
  };
  return ctx;
}

describe("ralph git worktree integration", () => {
  let tempRoot: string | undefined;

  beforeEach(() => {
    tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-ralph-integration-")));
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

  test("creates a relative git_worktree_dir from repo root and preserves the relative cwd", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const subdir = join(repo, "nested");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "fixture.txt"), "nested fixture\n", "utf8");
    execFileSync("git", ["add", "nested/fixture.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add nested fixture"], { cwd: repo, stdio: "ignore" });
    const expectedWorktreeRoot = join(repo, "worktrees", "ralph");
    const expectedCwd = join(expectedWorktreeRoot, "nested");
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
            assertSamePath(options.cwd, expectedCwd, "expected planner to run from corresponding worktree subdirectory");
            assertWorktreeRegistered(repo, expectedWorktreeRoot);
            assert.equal(
              execFileSync("git", ["-C", expectedWorktreeRoot, "rev-parse", "HEAD"]).toString().trim(),
              execFileSync("git", ["-C", repo, "rev-parse", "main"]).toString().trim(),
            );
          }
          return undefined;
        },
      },
    );

    const result = await runRalphModule(mod, ctx, subdir);

    assertRalphResultShape(result, expectedCwd);
    const planPath = String(result["plan_path"]);
    assert.equal(planPath.startsWith(expectedCwd), true);
    const orchestratorReads = ctx.calls.taskOptions["orchestrator-1"]?.[0]?.reads;
    assert.ok(Array.isArray(orchestratorReads) && orchestratorReads.includes(planPath));
    assertEveryRalphStageCwd(ctx, expectedCwd);
    assertWorktreeRegistered(repo, expectedWorktreeRoot);
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
      () => runRalphModule(mod, ctx, requireTempRoot()),
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

    await runRalphModule(mod, ctx, repo);

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

    await runRalphModule(mod, ctx, repo);

    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assert.equal(existsSync(uncommittedPath), true);
    assertWorktreeRegistered(repo, expectedWorktree);
  });

  test("fails fast when existing git_worktree_dir is a subdirectory of the invoking repository", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const requestedWorktree = join(repo, "src");
    mkdirSync(requestedWorktree, { recursive: true });
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: "src",
    });

    await assert.rejects(
      () => runRalphModule(mod, ctx, repo),
      /git_worktree_dir already exists but is not a Git worktree root/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("fails fast when existing git_worktree_dir is a subdirectory of a same-repository worktree", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const existingWorktree = join(requireTempRoot(), "existing-worktree-with-subdir");
    addDetachedWorktree(repo, existingWorktree);
    const requestedWorktree = join(existingWorktree, "nested");
    mkdirSync(requestedWorktree, { recursive: true });
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: requestedWorktree,
    });

    await assert.rejects(
      () => runRalphModule(mod, ctx, repo),
      /git_worktree_dir already exists but is not a Git worktree root/,
    );
    assert.deepEqual(ctx.calls.task, []);
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
      () => runRalphModule(mod, ctx, repo),
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
      () => runRalphModule(mod, ctx, repo),
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

    await runRalphModule(mod, firstCtx, repo);
    assertWorktreeRegistered(repo, expectedWorktree);
    await runRalphModule(mod, secondCtx, repo);

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
      () => runRalphModule(mod, ctx, repo),
      /Failed to create git worktree at requested git_worktree_dir/,
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("reports filesystem failures before invoking git worktree add", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js") as unknown as RalphTestModule;
    const repo = initializeGitRepository();
    const fileWhereParentDirectoryShouldBe = join(requireTempRoot(), "not-a-directory");
    const requestedWorktree = join(fileWhereParentDirectoryShouldBe, "worktree");
    writeFileSync(fileWhereParentDirectoryShouldBe, "blocks mkdir\n", "utf8");
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: requestedWorktree,
    });

    await assert.rejects(
      () => runRalphModule(mod, ctx, repo),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed to create parent directory for requested git_worktree_dir/);
        assert.doesNotMatch(error.message, /Git reported/);
        return true;
      },
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
      () => runRalphModule(mod, ctx, repo),
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
      () => runRalphModule(mod, ctx, repo),
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

    await runRalphModule(mod, ctx, repo);

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

    await assert.rejects(() => runRalphModule(mod, ctx, repo), /planner failed/);

    assertWorktreeRegistered(repo, expectedWorktree);
  });
});
