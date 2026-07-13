import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore, mockSession, runChain, runParallel, runTask } from "./executor-shared.js";

function createRepository(): { readonly root: string; readonly repo: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-direct-cleanup-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  runGitChecked(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "packages", "api", "tracked.txt"), "primary\n");
  runGitChecked(repo, ["add", "."]);
  runGitChecked(repo, [
    "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
    "commit", "--no-gpg-sign", "-m", "initial",
  ]);
  return { root, repo };
}

function assertNoTemporaryWorktrees(repo: string, expectedCheckouts = 1): void {
  const checkouts = runGitChecked(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  const generatedBranches = runGitChecked(repo, ["branch", "--list", "atomic-parallel-*"]).trim();
  assert.equal(checkouts.length, expectedCheckouts);
  assert.equal(generatedBranches, "");
}

test("temporary direct worktrees clean up when onRunStart fails before the callback", async () => {
  const { root, repo } = createRepository();
  try {
    await assert.rejects(
      runTask(
        { name: "writer", prompt: "write" },
        { cwd: repo, worktree: true, artifacts: false },
        {
          cwd: repo,
          store: createStore(),
          onRunStart() { throw new Error("startup failed"); },
        },
      ),
      /startup failed/,
    );
    assertNoTemporaryWorktrees(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary parallel worktrees clean up when max depth rejects before the callback", async () => {
  const { root, repo } = createRepository();
  try {
    const details = await runParallel(
      [{ name: "one", prompt: "one" }, { name: "two", prompt: "two" }],
      { cwd: repo, worktree: true, artifacts: false },
      { cwd: repo, depth: 1, config: { maxDepth: 1, defaultConcurrency: 1, persistRuns: false, statusFile: false, resumeInFlight: "never" }, store: createStore() },
    );
    assert.equal(details.status, "failed");
    assert.match(details.error ?? "", /maxDepth exceeded/);
    assertNoTemporaryWorktrees(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary chain worktrees clean up after a stage failure", async () => {
  const { root, repo } = createRepository();
  try {
    const details = await runChain(
      [{ name: "writer", prompt: "fail" }],
      { cwd: repo, worktree: true, artifacts: false },
      {
        cwd: repo,
        store: createStore(),
        adapters: {
          agentSession: {
            async create() {
              return { ...mockSession(), async prompt() { throw new Error("stage failed"); } };
            },
          },
        },
      },
    );
    assert.equal(details.status, "failed");
    assertNoTemporaryWorktrees(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent temporary direct invocations use distinct worktrees and clean both", async () => {
  const { root, repo } = createRepository();
  const sessionCwds: string[] = [];
  try {
    const runOne = (name: string) => runTask(
      { name, prompt: name },
      { cwd: repo, worktree: true, artifacts: false },
      {
        cwd: repo,
        store: createStore(),
        adapters: {
          agentSession: {
            async create(options) {
              sessionCwds.push(options.cwd ?? "");
              return mockSession();
            },
          },
        },
      },
    );
    const results = await Promise.all([runOne("one"), runOne("two")]);
    assert.deepEqual(results.map((item) => item.status), ["completed", "completed"]);
    assert.equal(new Set(sessionCwds).size, 2);
    assert.equal(sessionCwds.every((cwd) => cwd !== repo), true);
    assertNoTemporaryWorktrees(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary isolation invoked from a linked worktree preserves its nested cwd", async () => {
  const { root, repo } = createRepository();
  const linked = join(root, "linked source");
  runGitChecked(repo, ["worktree", "add", "--detach", linked]);
  const nested = join(linked, "packages", "api");
  let sessionCwd = "";
  try {
    const details = await runTask(
      { name: "writer", prompt: "write" },
      { cwd: nested, worktree: true, artifacts: false },
      {
        cwd: nested,
        store: createStore(),
        adapters: {
          agentSession: {
            async create(options) {
              sessionCwd = options.cwd ?? "";
              return mockSession();
            },
          },
        },
      },
    );
    assert.equal(details.status, "completed");
    assert.notEqual(sessionCwd, realpathSync(nested));
    assert.match(sessionCwd, /packages[/\\]api$/);
    assert.equal(runGitChecked(linked, ["status", "--porcelain"]), "");
    assertNoTemporaryWorktrees(repo, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function commitMarker(repo: string, name: string): void {
  writeFileSync(join(repo, name), `${name}\n`);
  runGitChecked(repo, ["add", name]);
  runGitChecked(repo, [
    "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
    "commit", "--no-gpg-sign", "-m", name,
  ]);
}

test("temporary direct and named tasks default to the runner invocation cwd", () => {
  const first = createRepository();
  const second = createRepository();
  const projectRoot = resolve(import.meta.dir, "../..");
  const probe = join(first.root, "invocation-cwd-probe.ts");
  commitMarker(first.repo, "repo-a.txt");
  commitMarker(second.repo, "repo-b.txt");
  commitMarker(first.repo, "packages/api/repo-a-nested.txt");
  commitMarker(second.repo, "packages/api/repo-b-nested.txt");
  writeFileSync(probe, `
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    import { run, runTask } from ${JSON.stringify(join(projectRoot, "packages/workflows/src/runs/foreground/executor.ts"))};
    import { workflow } from ${JSON.stringify(join(projectRoot, "packages/workflows/src/authoring/workflow.ts"))};
    import { createStore } from ${JSON.stringify(join(projectRoot, "packages/workflows/src/shared/store.ts"))};
    const [mode, repo, cwdMode] = process.argv.slice(2);
    const relative = cwdMode === "relative";
    let observed;
    const adapters = { prompt: { async prompt(_text, meta) {
      const cwd = meta.stageOptions?.cwd ?? "";
      const suffix = relative ? "-nested" : "";
      observed = {
        cwd,
        hasA: existsSync(join(cwd, "repo-a" + suffix + ".txt")),
        hasB: existsSync(join(cwd, "repo-b" + suffix + ".txt")),
      };
      return "ok";
    } } };
    let result;
    if (mode === "direct") {
      result = await runTask(
        { name: "writer", prompt: "write", ...(relative ? { cwd: "packages/api" } : {}) },
        { worktree: true, artifacts: false },
        { cwd: repo, adapters, store: createStore() },
      );
    } else {
      const definition = workflow({
        name: "invocation-cwd-probe", description: "", inputs: {}, outputs: {},
        run: async (ctx) => {
          await ctx.task("writer", {
            prompt: "write", worktree: true, artifacts: false,
            ...(relative ? { cwd: "packages/api" } : {}),
          });
          return {};
        },
      });
      result = await run(definition, {}, { cwd: repo, adapters, store: createStore() });
    }
    console.log(JSON.stringify({ status: result.status, observed }));
  `);
  try {
    for (const [mode, cwdMode] of [
      ["direct", "omitted"], ["direct", "relative"],
      ["named", "omitted"], ["named", "relative"],
    ] as const) {
      const child = Bun.spawnSync(["bun", probe, mode, second.repo, cwdMode], { cwd: first.repo, env: process.env });
      assert.equal(child.exitCode, 0, child.stderr.toString());
      const parsed = JSON.parse(child.stdout.toString().trim()) as {
        status: string;
        observed: { cwd: string; hasA: boolean; hasB: boolean };
      };
      assert.equal(parsed.status, "completed");
      assert.equal(parsed.observed.hasA, false, `${mode}/${cwdMode} used the process cwd repository`);
      assert.equal(parsed.observed.hasB, true, `${mode}/${cwdMode} did not use the invocation cwd repository`);
      if (cwdMode === "relative") assert.match(parsed.observed.cwd, /packages[/\\]api$/);
      assert.notEqual(parsed.observed.cwd, second.repo);
      assertNoTemporaryWorktrees(second.repo);
    }
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});
