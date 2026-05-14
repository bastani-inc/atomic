/**
 * dispatcher.test.ts
 *
 * Verifies the dispatcher's contract after the foreground execution mode
 * was removed (workflows are always background-scheduled):
 *
 *   - `dispatch("list")` and `dispatch("inputs")` are unaffected.
 *   - `dispatch("run")` always returns `status: "running"` synchronously
 *     and starts the workflow in the background.
 *   - Not-found workflow on `run` still returns a structured failed result
 *     (status "failed", empty runId).
 *   - `DispatcherOpts` no longer accepts `ui` (build the background adapter
 *     yourself if you need to drive a synchronous executor in tests).
 *   - `persistence` is still forwarded so lifecycle entries are written.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { WorkflowDefinition, WorkflowPersistencePort } from "../../src/shared/types.js";
import { createRegistry } from "../../src/workflows/registry.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import { dispatch } from "../../src/extension/dispatcher.js";
import { createStore } from "../../src/shared/store.js";
import { createCancellationRegistry } from "../../src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../src/runs/background/job-tracker.js";
import type { DispatcherOpts } from "../../src/extension/dispatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(name: string): WorkflowDefinition {
  return defineWorkflow(name)
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;
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

  test("returns before the workflow body settles", async () => {
    let settled = false;
    const slowWf = defineWorkflow("slow-bg-wf")
      .run(async (_ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        settled = true;
        return {};
      })
      .compile() as WorkflowDefinition;

    const registry = createRegistry([slowWf]);
    const t0 = Date.now();
    const result = await dispatch(
      { action: "run", workflow: "slow-bg-wf", inputs: {} },
      { registry, ...freshDeps() },
    );
    const elapsed = Date.now() - t0;

    assert.equal(result.action, "run");
    assert.ok(elapsed < 100, "dispatch must not wait for the background promise");
    assert.equal(settled, false);
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

  const stageWorkflow = defineWorkflow("dispatch-persist-test")
    .run(async (ctx) => {
      await ctx.stage("s1").prompt("go");
      return { ok: true };
    })
    .compile() as WorkflowDefinition;

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
      calls.map((c) => c.type),
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
