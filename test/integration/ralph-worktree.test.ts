import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  WorkflowChainOptions,
  WorkflowDefinition,
  WorkflowParallelOptions,
  WorkflowRunContext,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowUIContext,
} from "../../packages/workflows/src/shared/types.js";

interface MockCalls {
  readonly task: string[];
  readonly parallelOptions: WorkflowParallelOptions[];
  readonly taskOptions: Record<string, WorkflowTaskOptions[]>;
}

interface MockResponders {
  task?: (name: string, options: WorkflowTaskOptions, calls: MockCalls) => string | undefined;
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
      return Promise.all(steps.map((step) => runTask(step.name, step)));
    },
    ui,
  };
}

describe("ralph git worktree integration", () => {
  let previousCwd: string;
  let tempRoot: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "atomic-ralph-integration-"));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function requireTempRoot(): string {
    if (tempRoot === undefined) throw new Error("expected Ralph integration temp root");
    return tempRoot;
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

  function assertEveryRalphStageCwd(
    ctx: { readonly calls: MockCalls },
    expectedCwd: string | undefined,
  ): void {
    for (const [taskName, entries] of Object.entries(ctx.calls.taskOptions)) {
      for (const options of entries) {
        assert.equal(options.cwd, expectedCwd, `unexpected cwd for ${taskName}`);
      }
    }
    for (const options of ctx.calls.parallelOptions) {
      assert.equal(options.cwd, expectedCwd, "unexpected cwd for parallel stage");
    }
  }

  function worktreeListEntries(repo: string): readonly string[] {
    return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"])
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }

  function normalizePathForComparison(path: string): string {
    const normalized = path.replace(/\\/g, "/");
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

  function assertWorktreeWasRemoved(repo: string, worktreePath: string): void {
    assert.equal(existsSync(worktreePath), false, "expected Ralph-created worktree checkout to be removed");
    const expectedPath = normalizePathForComparison(worktreePath);
    assert.equal(
      worktreeListEntries(repo).some((entry) => normalizePathForComparison(entry) === expectedPath),
      false,
      "expected git worktree metadata to be removed",
    );
  }

  test("creates a relative git_worktree_dir and removes it after success", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "worktrees", "ralph");
    process.chdir(repo);
    const ctx = makeMockCtx(
      {
        prompt: "Add a small feature",
        max_loops: 1,
        base_branch: "main",
        git_worktree_dir: join("..", "worktrees", "ralph"),
      },
      {
        task: (name, options) => {
          if (name === "planner-1") {
            assert.equal(options.cwd, expectedWorktree);
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

    const result = await d.run(ctx);

    assert.ok(String(result["plan_path"]).startsWith(join(repo, "specs")));
    assert.equal(String(result["plan_path"]).startsWith(expectedWorktree), false);
    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assertWorktreeWasRemoved(repo, expectedWorktree);
  });

  test("creates an absolute git_worktree_dir and removes it after success", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "absolute-worktrees", "ralph");
    process.chdir(repo);
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: expectedWorktree,
    });

    await d.run(ctx);

    assertEveryRalphStageCwd(ctx, expectedWorktree);
    assertWorktreeWasRemoved(repo, expectedWorktree);
  });

  test("fails fast with recovery guidance when requested git_worktree_dir cannot be created", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    const occupiedWorktreePath = join(requireTempRoot(), "occupied-worktree");
    mkdirSync(occupiedWorktreePath, { recursive: true });
    writeFileSync(join(occupiedWorktreePath, "README.md"), "already here\n", "utf8");
    process.chdir(repo);
    const ctx = makeMockCtx({
      prompt: "Add a small feature",
      max_loops: 1,
      base_branch: "main",
      git_worktree_dir: occupiedWorktreePath,
    });

    await assert.rejects(
      () => d.run(ctx),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed to create git worktree at requested git_worktree_dir/);
        assert.match(error.message, /git -C .* worktree remove --force/);
        return true;
      },
    );
    assert.deepEqual(ctx.calls.task, []);
  });

  test("can re-run with the same git_worktree_dir after successful cleanup", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "repeat-worktree");
    process.chdir(repo);

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

    await d.run(firstCtx);
    assertWorktreeWasRemoved(repo, expectedWorktree);
    await d.run(secondCtx);

    assertEveryRalphStageCwd(firstCtx, expectedWorktree);
    assertEveryRalphStageCwd(secondCtx, expectedWorktree);
    assertWorktreeWasRemoved(repo, expectedWorktree);
  });

  test("falls back to a default worktree path when git_worktree_dir is invalid", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    process.chdir(repo);
    let fallbackWorktree: string | undefined;
    const ctx = makeMockCtx(
      {
        prompt: "Add a small feature",
        max_loops: 1,
        base_branch: "main",
        git_worktree_dir: "invalid\0path",
      },
      {
        task: (name, options) => {
          if (name === "planner-1") {
            const cwd = options.cwd;
            if (cwd === undefined) throw new Error("expected planner cwd to use fallback worktree");
            fallbackWorktree = cwd;
            assertWorktreeRegistered(repo, cwd);
            assert.equal(
              execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"]).toString().trim(),
              execFileSync("git", ["-C", repo, "rev-parse", "main"]).toString().trim(),
            );
          }
          return undefined;
        },
      },
    );

    const result = await d.run(ctx);
    if (fallbackWorktree === undefined) throw new Error("expected planner cwd to use fallback worktree");

    assert.ok(isAbsolute(fallbackWorktree));
    assert.ok(fallbackWorktree.startsWith(join(tmpdir(), "atomic-ralph-worktrees")));
    assert.ok(String(result["plan_path"]).startsWith(join(repo, "specs")));
    assert.equal(String(result["plan_path"]).startsWith(fallbackWorktree), false);
    assertEveryRalphStageCwd(ctx, fallbackWorktree);
    assertWorktreeWasRemoved(repo, fallbackWorktree);
  });

  test("preserves the worktree for recovery when the workflow fails", async () => {
    const mod = await import("../../packages/workflows/builtin/ralph.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const repo = initializeGitRepository();
    const expectedWorktree = join(requireTempRoot(), "failed-run-worktree");
    process.chdir(repo);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
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

      await assert.rejects(() => d.run(ctx), /planner failed/);
    } finally {
      console.warn = originalWarn;
    }

    assertWorktreeRegistered(repo, expectedWorktree);
    assert.match(warnings.join("\n"), /Preserving Ralph git worktree after failed run/);
    assert.match(warnings.join("\n"), /git -C .* worktree remove --force/);
  });
});
