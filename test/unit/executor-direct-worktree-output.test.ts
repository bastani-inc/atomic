import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkflowArtifact, WorkflowDetails } from "../../packages/workflows/src/shared/types.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { createStore, mockSession, runChain, runParallel, runTask } from "./executor-shared.js";

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly worktree: string;
}

function createRepository(): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-output-isolation-")));
  const repo = join(root, "primary");
  mkdirSync(repo);
  runGitChecked(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "primary\n");
  runGitChecked(repo, ["add", "."]);
  runGitChecked(repo, [
    "-c", "user.name=Atomic Test", "-c", "user.email=atomic-test@example.com",
    "commit", "--no-gpg-sign", "-m", "initial",
  ]);
  return { root, repo, worktree: join(root, "reusable") };
}

function outputArtifacts(details: WorkflowDetails): WorkflowArtifact[] {
  return (details.artifacts ?? []).filter((artifact) => artifact.kind === "output");
}

function cleanupRunnerOutputs(details: WorkflowDetails): void {
  for (const runDir of new Set(outputArtifacts(details).map((artifact) => dirname(dirname(dirname(artifact.path)))))) {
    rmSync(runDir, { recursive: true, force: true });
  }
}

function assertDurableOutputs(details: WorkflowDetails, expected: readonly string[]): void {
  assert.equal(details.status, "completed");
  assert.equal(details.results?.every((result) => result.text === ""), true);
  const artifacts = outputArtifacts(details);
  assert.equal(artifacts.length, expected.length);
  assert.deepEqual(artifacts.map((artifact) => readFileSync(artifact.path, "utf8")).sort(), [...expected].sort());
  for (const artifact of artifacts) {
    assert.equal(existsSync(artifact.path), true);
    assert.match(realpathSync(artifact.path), /atomic-workflow-outputs/);
  }
  cleanupRunnerOutputs(details);
}

const promptAdapter = { prompt: async (text: string) => `saved:${text}` };

test("temporary direct relative file-only output survives worktree cleanup", async () => {
  const fixture = createRepository();
  try {
    const details = await runTask(
      { name: "direct", prompt: "direct", output: "direct.txt", outputMode: "file-only" },
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assertDurableOutputs(details, ["saved:direct"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary parallel relative file-only outputs survive worktree cleanup", async () => {
  const fixture = createRepository();
  try {
    const details = await runParallel(
      [
        { name: "one", prompt: "one", output: "one.txt", outputMode: "file-only" },
        { name: "two", prompt: "two", output: "two.txt", outputMode: "file-only" },
      ],
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assertDurableOutputs(details, ["saved:one", "saved:two"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary sequential-chain relative file-only outputs survive worktree cleanup", async () => {
  const fixture = createRepository();
  try {
    const details = await runChain(
      [
        { name: "one", prompt: "one", output: "one.txt", outputMode: "file-only" },
        { name: "two", prompt: "two", output: "two.txt", outputMode: "file-only" },
      ],
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assertDurableOutputs(details, ["saved:one", "saved:two"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary parallel-chain relative file-only outputs survive worktree cleanup", async () => {
  const fixture = createRepository();
  try {
    const details = await runChain(
      [{ parallel: [
        { name: "one", prompt: "one", output: "one.txt", outputMode: "file-only" },
        { name: "two", prompt: "two", output: "two.txt", outputMode: "file-only" },
      ] }],
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assertDurableOutputs(details, ["saved:one", "saved:two"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("temporary parallel tasks namespace identical relative outputs per task", async () => {
  const fixture = createRepository();
  try {
    const details = await runParallel(
      [
        { name: "one", prompt: "one", output: "same.txt", outputMode: "file-only" },
        { name: "two", prompt: "two", output: "same.txt", outputMode: "file-only" },
      ],
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    const artifacts = outputArtifacts(details);
    assert.equal(details.status, "completed");
    assert.equal(new Set(artifacts.map((artifact) => artifact.path)).size, 2);
    assert.deepEqual(
      Object.fromEntries(artifacts.map((artifact) => [artifact.taskName, readFileSync(artifact.path, "utf8")])),
      { one: "saved:one", two: "saved:two" },
    );
    cleanupRunnerOutputs(details);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary parallel-chain tasks namespace identical relative outputs per task", async () => {
  const fixture = createRepository();
  try {
    const details = await runChain(
      [{ parallel: [
        { name: "one", prompt: "one", output: "same.txt", outputMode: "file-only" },
        { name: "two", prompt: "two", output: "same.txt", outputMode: "file-only" },
      ] }],
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    const artifacts = outputArtifacts(details);
    assert.equal(details.status, "completed");
    assert.equal(new Set(artifacts.map((artifact) => artifact.path)).size, 2);
    assert.deepEqual(
      Object.fromEntries(artifacts.map((artifact) => [artifact.taskName, readFileSync(artifact.path, "utf8")])),
      { one: "saved:one", two: "saved:two" },
    );
    cleanupRunnerOutputs(details);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner-managed relative outputs reject lexical traversal", async () => {
  for (const isolation of ["reusable", "temporary"] as const) {
    const fixture = createRepository();
    const escaped = join(fixture.root, `${isolation}-escaped.txt`);
    try {
      const details = await runTask(
        { name: "writer", prompt: "write", output: `../../../../../../${isolation}-escaped.txt` },
        isolation === "reusable"
          ? { cwd: fixture.repo, gitWorktreeDir: fixture.worktree }
          : { cwd: fixture.repo, worktree: true, artifacts: false },
        { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
      );
      assert.equal(details.status, "failed");
      assert.match(details.error ?? "", /relative output .* escapes/);
      assert.equal(existsSync(escaped), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("reusable relative output rejects directory and existing-file symlink escapes", async () => {
  for (const kind of ["directory", "file", "dangling-file"] as const) {
    const fixture = createRepository();
    const escaped = join(fixture.repo, `${kind}-escaped.txt`);
    try {
      runGitChecked(fixture.repo, ["worktree", "add", "--detach", fixture.worktree]);
      const output = kind === "directory" ? "escape/out.txt" : "out.txt";
      if (kind === "directory") {
        symlinkSync(fixture.repo, join(fixture.worktree, "escape"), process.platform === "win32" ? "junction" : "dir");
      } else {
        if (kind === "file") writeFileSync(escaped, "original\n");
        symlinkSync(escaped, join(fixture.worktree, output), "file");
      }
      const details = await runTask(
        { name: "writer", prompt: "write", output },
        { cwd: fixture.repo, gitWorktreeDir: fixture.worktree },
        { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
      );
      assert.equal(details.status, "failed");
      assert.match(details.error ?? "", /cannot resolve relative output|relative output .* symlink|relative output .* resolves outside/);
      if (kind === "file") assert.equal(readFileSync(escaped, "utf8"), "original\n");
      else assert.equal(existsSync(escaped), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("temporary relative output rejects a directory symlink escape", async () => {
  const fixture = createRepository();
  const runId = `output-symlink-${crypto.randomUUID()}`;
  const outputBase = join(tmpdir(), "atomic-workflow-outputs", runId, "single", "0");
  const escaped = join(fixture.repo, "escaped.txt");
  try {
    const details = await runTask(
      { name: "writer", prompt: "write", output: "escape/out.txt" },
      { cwd: fixture.repo, worktree: true, artifacts: false },
      {
        cwd: fixture.repo,
        runId,
        store: createStore(),
        adapters: {
          agentSession: {
            async create() {
              return {
                ...mockSession(),
                async prompt() {
                  mkdirSync(outputBase, { recursive: true });
                  symlinkSync(fixture.repo, join(outputBase, "escape"), process.platform === "win32" ? "junction" : "dir");
                },
              };
            },
          },
        },
      },
    );
    assert.equal(details.status, "failed");
    assert.match(details.error ?? "", /relative output .* resolves outside/);
    assert.equal(existsSync(escaped), false);
  } finally {
    rmSync(join(tmpdir(), "atomic-workflow-outputs", runId), { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary worktrees preserve explicit absolute output and nonblank chainDir locations", async () => {
  const fixture = createRepository();
  const absoluteOutput = join(fixture.root, "absolute.txt");
  const chainDir = join(fixture.root, "chain-output");
  try {
    const direct = await runTask(
      { name: "direct", prompt: "direct", output: absoluteOutput },
      { cwd: fixture.repo, worktree: true, artifacts: false },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    const chain = await runChain(
      [{ name: "chain", prompt: "chain", output: "chain.txt" }],
      { cwd: fixture.repo, worktree: true, artifacts: false, chainDir },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assert.equal(direct.status, "completed");
    assert.equal(chain.status, "completed");
    assert.equal(readFileSync(absoluteOutput, "utf8"), "saved:direct");
    assert.equal(readFileSync(join(chainDir, "chain.txt"), "utf8"), "saved:chain");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("blank chainDir is omitted for sequential and parallel reusable chains", async () => {
  const fixture = createRepository();
  try {
    const sequential = await runChain(
      [{ name: "seq", prompt: "seq", output: "seq.txt" }],
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree, chainDir: "   " },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    const parallel = await runChain(
      [{ parallel: [{ name: "par", prompt: "par", output: "par.txt" }] }],
      { cwd: fixture.repo, gitWorktreeDir: fixture.worktree, chainDir: "" },
      { cwd: fixture.repo, adapters: { prompt: promptAdapter }, store: createStore() },
    );
    assert.equal(sequential.status, "completed");
    assert.equal(parallel.status, "completed");
    assert.equal(readFileSync(join(fixture.worktree, "seq.txt"), "utf8"), "saved:seq");
    assert.equal(readFileSync(join(fixture.worktree, "par.txt"), "utf8"), "saved:par");
    assert.equal(existsSync(join(fixture.repo, "seq.txt")), false);
    assert.equal(existsSync(join(fixture.repo, "par.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("reusable output persistence rejects valid same-repository target replacement after the final stage", async () => {
  const fixture = createRepository();
  try {
    let replacementOutput = "";
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
                  runGitChecked(fixture.repo, ["worktree", "add", "--detach", fixture.worktree]);
                  replacementOutput = join(fixture.worktree, "result.txt");
                },
              };
            },
          },
        },
      },
    );
    assert.equal(details.status, "failed");
    assert.match(details.error ?? "", /Cached gitWorktreeDir changed before reuse/);
    assert.equal(existsSync(replacementOutput), false);
    assert.equal(existsSync(join(fixture.repo, "result.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
