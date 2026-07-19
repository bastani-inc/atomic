/**
 * dispatcher.test.ts
 *
 * Verifies the dispatcher's contract after the foreground execution mode
 * was removed (workflows are always background-scheduled):
 *
 *   - `dispatch("list")` and `dispatch("inputs")` are unaffected.
 *   - `dispatch("run")` returns `status: "running"` synchronously in the
 *     interactive policy and starts the workflow in the background.
 *   - non-interactive policy awaits the detached job's terminal snapshot.
 *   - Not-found workflow on `run` still returns a structured failed result
 *     (status "failed", empty runId).
 *   - `DispatcherOpts` no longer accepts `ui` (build the background adapter
 *     yourself if you need to drive a synchronous executor in tests).
 *   - `persistence` is still forwarded so lifecycle entries are written.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition, WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type } from "typebox";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { DispatcherOpts } from "../../packages/workflows/src/extension/dispatcher.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(name: string): WorkflowDefinition {
  return workflow({
    name: name,
    description: "",
    inputs: {},
    outputs: {
      ok: Type.Optional(Type.Any()),
    },
    run: async (_ctx) => ({ ok: true }),
  }) as WorkflowDefinition;
}

function freshDeps() {
  return {
    store: createStore(),
    cancellation: createCancellationRegistry(),
    jobs: createJobTracker(),
  };
}

async function waitForRunEnded(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((r) => r.id === runId);
    if (run?.endedAt !== undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not end in time`);
}

// ---------------------------------------------------------------------------
// dispatch("list")
// ---------------------------------------------------------------------------

describe("dispatch list", () => {
  test("returns workflow items with name + description + inputs", async () => {
    const wf = makeWorkflow("alpha");
    const registry = createRegistry([wf]);
    const result = await dispatch({ action: "list" }, { registry });
    assert.equal(result.action, "list");
    if (result.action === "list") {
      assert.ok(result.items.some((i) => i.name === "alpha"));
      const alpha = result.items.find((i) => i.name === "alpha")!;
      assert.equal(typeof alpha.description, "string");
      assert.ok(Array.isArray(alpha.inputs));
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch("inputs")
// ---------------------------------------------------------------------------

describe("dispatch inputs", () => {
  test("returns schema for a known workflow", async () => {
    const wf = makeWorkflow("beta");
    const registry = createRegistry([wf]);
    const result = await dispatch({ action: "inputs", workflow: "beta" }, { registry });
    assert.equal(result.action, "inputs");
  });

  test("unknown workflow returns an error result", async () => {
    const registry = createRegistry([]);
    const result = await dispatch({ action: "inputs", workflow: "no-such" }, { registry });
    assert.equal(result.action, "inputs");
    if (result.action === "inputs") {
      assert.match(result.error!, /not found/i);
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch("run") — always background
// ---------------------------------------------------------------------------

describe("dispatch run (always background)", () => {
  test("returns action:run, status:running, runId, and empty stages synchronously", async () => {
    const wf = makeWorkflow("bg-wf");
    const registry = createRegistry([wf]);
    const result = await dispatch(
      { action: "run", workflow: "bg-wf", inputs: {} },
      { registry, ...freshDeps() },
    );
    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "running");
      assert.deepEqual(result.stages, []);
      assert.ok(result.runId);
    }
  });

  test("returns after startup admission without waiting for workflow completion", async () => {
    let bodyStarted = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slowWf = workflow({
      name: "slow-bg-wf",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => {
        bodyStarted = true;
        await held;
        return {};
      },
    }) as WorkflowDefinition;

    const deps = freshDeps();
    const result = await dispatch(
      { action: "run", workflow: "slow-bg-wf", inputs: {} },
      { registry: createRegistry([slowWf]), ...deps },
    );

    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "running");
      assert.equal(bodyStarted, true);
      assert.equal(deps.jobs.has(result.runId), true, "admitted body remains a live background job");
      release();
      await deps.jobs.get(result.runId)?.promise;
    }
  });

  test("returns invalid input-bound worktree setup errors before claiming background admission", async () => {
    const deps = freshDeps();
    let bodyStarted = false;
    const wf = workflow({
      name: "invalid-worktree-launch",
      description: "",
      inputs: { git_worktree_dir: Type.String() },
      outputs: {},
      worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
      run: async () => {
        bodyStarted = true;
        return {};
      },
    }) as never as WorkflowDefinition;
    const fixtureRoot = mkdtempSync(join(tmpdir(), "workflow-launch-repo-"));
    const repo = join(fixtureRoot, "repo");
    const correctedWorktree = join(fixtureRoot, "worktree");
    mkdirSync(join(repo, "packages"), { recursive: true });
    writeFileSync(join(repo, "packages", "tracked.txt"), "primary\n");
    runGitChecked(repo, ["init", "-b", "main"]);
    runGitChecked(repo, ["add", "."]);
    runGitChecked(repo, ["-c", "user.name=Atomic Tests", "-c", "user.email=atomic@example.com", "commit", "-m", "initial"]);

    try {
      const result = await dispatch(
        { action: "run", workflow: "invalid-worktree-launch", inputs: { git_worktree_dir: join(repo, "packages") } },
        { registry: createRegistry([wf]), cwd: repo, ...deps },
      );

      assert.equal(result.action, "run");
      if (result.action === "run") {
        assert.equal(result.status, "failed");
        assert.ok(result.runId, "the rejected launch retains its allocated run identity");
        assert.match(result.error ?? "", /gitWorktreeDir must be outside the invoking checkout/);
        assert.equal(result.message, undefined);
        assert.equal(deps.jobs.has(result.runId), false);
        assert.equal(deps.cancellation.abort(result.runId), false);
        assert.equal(deps.store.runs().some((run) => run.id === result.runId), false);
      }
      assert.equal(bodyStarted, false);

      const retry = await dispatch(
        { action: "run", workflow: "invalid-worktree-launch", inputs: { git_worktree_dir: correctedWorktree } },
        { registry: createRegistry([wf]), cwd: repo, ...deps },
      );
      assert.equal(retry.action, "run");
      if (retry.action === "run") {
        assert.equal(retry.status, "running");
        await deps.jobs.get(retry.runId)?.promise;
      }
      assert.equal(bodyStarted, true);
    } finally {
      if (deps.jobs.runIds().length > 0) {
        await Promise.all(deps.jobs.runIds().map(async (id) => deps.jobs.get(id)?.promise));
      }
      try {
        runGitChecked(repo, ["worktree", "remove", "--force", correctedWorktree]);
      } catch {
        // The setup may have failed before creating a worktree.
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("not-found workflow returns failed result with empty runId", async () => {
    const registry = createRegistry([]);
    const result = await dispatch(
      { action: "run", workflow: "ghost", inputs: {} },
      { registry, ...freshDeps() },
    );
    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "failed");
      assert.equal(result.runId, "");
      assert.match(result.error!, /not found/i);
    }
  });

  test("non-interactive policy awaits terminal snapshot", async () => {
    const deps = freshDeps();
    let settled = false;
    const wf = workflow({
      name: "headless-bg-wait",
      description: "",
      inputs: {},
      outputs: {
        ok: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const text = await ctx.stage("done").prompt("finish");
        settled = true;
        return { ok: text };
      },
    }) as WorkflowDefinition;
    const registry = createRegistry([wf]);

    const seenExecutionModes: Array<string | undefined> = [];
    const result = await dispatch(
      { action: "run", workflow: "headless-bg-wait", inputs: {} },
      {
        registry,
        adapters: { prompt: { prompt: async (_text, meta) => { seenExecutionModes.push(meta?.executionMode); return "true"; } } },
        ...deps,
        policy: NON_INTERACTIVE_WORKFLOW_POLICY,
      },
    );

    assert.equal(settled, true);
    assert.deepEqual(seenExecutionModes, ["non_interactive"]);
    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "completed");
      assert.deepEqual(result.result, { ok: "true" });
      assert.equal(result.stages?.length, 1);
      assert.ok(result.runId);
    }
  });

  test("missing required inputs fail before non-interactive dispatch starts a job", async () => {
    const deps = freshDeps();
    const wf = workflow({
      name: "requires-input",
      description: "",
      inputs: {
        prompt: Type.String(),
      },
      outputs: {
        ok: Type.Optional(Type.Any()),
      },
      run: async () => ({ ok: true }),
    }) as never as WorkflowDefinition;
    const registry = createRegistry([wf]);

    const result = await dispatch(
      { action: "run", workflow: "requires-input", inputs: {} },
      { registry, ...deps, policy: NON_INTERACTIVE_WORKFLOW_POLICY },
    );

    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "failed");
      assert.equal(result.runId, "");
      assert.match(result.error ?? "", /required input "prompt" not provided/);
      assert.equal(deps.jobs.runIds().length, 0);
    }
  });

  test("dispatch result includes name and a 'started in background' message", async () => {
    const wf = makeWorkflow("named-bg");
    const registry = createRegistry([wf]);
    const result = await dispatch(
      { action: "run", workflow: "named-bg", inputs: {} },
      { registry, ...freshDeps() },
    );
    if (result.action === "run") {
      assert.equal(result.name, "named-bg");
      assert.ok((result as { message?: string }).message?.includes("named-bg"));
    }
  });
});

// ---------------------------------------------------------------------------
// dispatch("run") — persistence forwarded to the background runner
// ---------------------------------------------------------------------------

describe("dispatch run forwards persistence", () => {
  function makePersistence() {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence: WorkflowPersistencePort = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        calls.push({ type, payload });
        return `entry-${calls.length}`;
      },
    };
    return { persistence, calls };
  }

  function lifecycleTypes(calls: Array<{ type: string }>): string[] {
    return calls.map((c) => c.type);
  }

  const stageWorkflow = workflow({
    name: "dispatch-persist-test",
    description: "",
    inputs: {},
    outputs: {
      ok: Type.Optional(Type.Any()),
    },
    run: async (ctx) => {
      await ctx.stage("s1").prompt("go");
      return { ok: true };
    },
  }) as WorkflowDefinition;

  const noopAdapters = { prompt: { prompt: async () => "done" } };

  test("appendEntry fires the full lifecycle for a background run", async () => {
    const { persistence, calls } = makePersistence();
    const registry = createRegistry([stageWorkflow]);
    const deps = freshDeps();

    const result = await dispatch(
      { action: "run", workflow: "dispatch-persist-test", inputs: {} },
      { registry, adapters: noopAdapters, persistence, ...deps },
    );
    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "running");
      await waitForRunEnded(deps.store, result.runId);
    }

    assert.deepEqual(
      lifecycleTypes(calls),
      [
        "workflow.run.start",
        "workflow.stage.start",
        "workflow.stage.end",
        "workflow.run.end",
      ],
    );
  });

  test("DispatcherOpts accepts persistence field — type-level check", () => {
    const registry = createRegistry([]);
    const { persistence } = makePersistence();
    const opts: DispatcherOpts = { registry, persistence };
    assert.equal(opts.persistence, persistence);
  });

  test("dispatch without persistence — background run still completes", async () => {
    const registry = createRegistry([stageWorkflow]);
    const deps = freshDeps();
    const result = await dispatch(
      { action: "run", workflow: "dispatch-persist-test", inputs: {} },
      { registry, adapters: noopAdapters, ...deps },
    );
    assert.equal(result.action, "run");
    if (result.action === "run") {
      await waitForRunEnded(deps.store, result.runId);
      const run = deps.store.runs().find((r) => r.id === result.runId);
      assert.equal(run?.status, "completed");
    }
  });
});

// ---------------------------------------------------------------------------
// DispatcherOpts shape — type-level guards
// ---------------------------------------------------------------------------

describe("DispatcherOpts shape", () => {
  test("accepts jobs override", () => {
    const registry = createRegistry([]);
    const opts: DispatcherOpts = { registry, jobs: undefined };
    assert.equal(opts.jobs, undefined);
  });

  test("accepts cancellation override", () => {
    const registry = createRegistry([]);
    const cancellation = createCancellationRegistry();
    const opts: DispatcherOpts = { registry, cancellation };
    assert.equal(opts.cancellation, cancellation);
  });
});
