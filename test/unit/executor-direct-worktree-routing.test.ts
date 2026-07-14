import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore, mockSession, runChain, runParallel, runTask } from "./executor-shared.js";

interface RepositoryFixture {
  readonly root: string;
  readonly repo: string;
  readonly nested: string;
  readonly worktree: string;
}

function createRepository(prefix = "atomic direct routing "): RepositoryFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "primary repo");
  const nested = join(repo, "packages", "api");
  mkdirSync(nested, { recursive: true });
  runGitChecked(repo, ["init", "-b", "main"]);
  writeFileSync(join(nested, "tracked.txt"), "primary\n");
  runGitChecked(repo, ["add", "."]);
  runGitChecked(repo, [
    "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
    "commit", "--no-gpg-sign", "-m", "initial",
  ]);
  return { root, repo, nested, worktree: join(root, "reusable worktree") };
}

function sessionRecorder(cwds: string[]) {
  return {
    async create(options: { cwd?: string }) {
      cwds.push(options.cwd ?? "");
      return mockSession();
    },
  };
}

test("direct reusable worktrees route relative output beside an absolute nested cwd", async () => {
  const fixture = createRepository();
  try {
    const cwds: string[] = [];
    const details = await runTask(
      { name: "writer", prompt: "write", output: "result.txt" },
      { cwd: fixture.nested, gitWorktreeDir: fixture.worktree },
      {
        cwd: fixture.nested,
        adapters: { agentSession: sessionRecorder(cwds) },
        store: createStore(),
      },
    );

    assert.equal(details.status, "completed");
    assert.equal(realpathSync(cwds[0] ?? ""), realpathSync(join(fixture.worktree, "packages", "api")));
    assert.equal(readFileSync(join(fixture.worktree, "packages", "api", "result.txt"), "utf8"), "ok");
    assert.equal(existsSync(join(fixture.nested, "result.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("parallel chain steps route relative outputs into the reusable worktree", async () => {
  const fixture = createRepository();
  try {
    const details = await runChain(
      [{ parallel: [
        { name: "one", prompt: "one", output: "one.txt" },
        { name: "two", prompt: "two", output: "two.txt" },
      ] }],
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree },
      {
        cwd: fixture.repo,
        adapters: { prompt: { prompt: async (text) => `result:${text}` } },
        store: createStore(),
      },
    );
    assert.equal(details.status, "completed");
    assert.equal(readFileSync(join(fixture.worktree, "one.txt"), "utf8"), "result:one");
    assert.equal(readFileSync(join(fixture.worktree, "two.txt"), "utf8"), "result:two");
    assert.equal(existsSync(join(fixture.repo, "one.txt")), false);
    assert.equal(existsSync(join(fixture.repo, "two.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("relative cwd and a positive symlink alias stay inside a reusable worktree", async () => {
  const fixture = createRepository();
  const alias = join(fixture.root, "worktree alias");
  try {
    runGitChecked(fixture.repo, ["worktree", "add", "--detach", fixture.worktree]);
    symlinkSync(fixture.worktree, alias, process.platform === "win32" ? "junction" : "dir");
    const cwds: string[] = [];
    const details = await runTask(
      { name: "writer", prompt: "write", cwd: "packages/api", output: "relative.txt" },
      { gitWorktreeDir: alias },
      {
        cwd: fixture.repo,
        adapters: { agentSession: sessionRecorder(cwds) },
        store: createStore(),
      },
    );
    assert.equal(details.status, "completed");
    assert.equal(realpathSync(cwds[0] ?? ""), realpathSync(join(fixture.worktree, "packages", "api")));
    assert.equal(readFileSync(join(fixture.worktree, "packages", "api", "relative.txt"), "utf8"), "ok");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit absolute output and chainDir retain their caller-selected locations", async () => {
  const fixture = createRepository();
  const absoluteOutput = join(fixture.root, "absolute.txt");
  const chainDir = join(fixture.root, "chain artifacts");
  try {
    const direct = await runTask(
      { name: "direct", prompt: "direct", output: absoluteOutput },
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree },
      { cwd: fixture.repo, adapters: { prompt: { prompt: async () => "absolute" } }, store: createStore() },
    );
    const chain = await runChain(
      [{ name: "chain", prompt: "chain", output: "chain.txt" }],
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree, chainDir },
      { cwd: fixture.repo, adapters: { prompt: { prompt: async () => "chain" } }, store: createStore() },
    );
    assert.equal(direct.status, "completed");
    assert.equal(chain.status, "completed");
    assert.equal(readFileSync(absoluteOutput, "utf8"), "absolute");
    assert.equal(readFileSync(join(chainDir, "chain.txt"), "utf8"), "chain");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ordinary non-worktree task parallel and chain keep their requested cwd", async () => {
  const fixture = createRepository();
  const cwds: string[] = [];
  try {
    const runOptions = {
      cwd: fixture.nested,
      adapters: { agentSession: sessionRecorder(cwds) },
      store: createStore(),
    };
    const direct = await runTask({ name: "direct", prompt: "direct" }, { cwd: fixture.nested }, runOptions);
    const parallel = await runParallel(
      [{ name: "one", prompt: "one" }, { name: "two", prompt: "two" }],
      { cwd: fixture.nested },
      { ...runOptions, store: createStore() },
    );
    const chain = await runChain(
      [{ name: "first", prompt: "first" }, { name: "second", prompt: "second" }],
      { cwd: fixture.nested },
      { ...runOptions, store: createStore() },
    );
    assert.deepEqual([direct.status, parallel.status, chain.status], ["completed", "completed", "completed"]);
    assert.equal(cwds.length, 5);
    assert.equal(cwds.every((cwd) => realpathSync(cwd) === realpathSync(fixture.nested)), true);
    assert.equal(runGitChecked(fixture.repo, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)?.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner-managed relative output rejects a reusable worktree replaced after the session", async () => {
  const fixture = createRepository();
  try {
    const details = await runTask(
      { name: "writer", prompt: "replace target", output: "result.txt" },
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree },
      {
        cwd: fixture.repo,
        store: createStore(),
        adapters: {
          agentSession: {
            async create() {
              return {
                ...mockSession(),
                async prompt() {
                  runGitChecked(fixture.repo, ["worktree", "remove", "--force", fixture.worktree]);
                  symlinkSync(fixture.repo, fixture.worktree, process.platform === "win32" ? "junction" : "dir");
                },
              };
            },
          },
        },
      },
    );
    assert.equal(details.status, "failed");
    assert.match(details.error ?? "", /gitWorktreeDir must not resolve to the invoking checkout/);
    assert.equal(existsSync(join(fixture.repo, "result.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
