import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

const runId = "active-blocked-claim";

afterEach(() => setDurableBackend(undefined));

function seedBlockedRun() {
  const store = createStore();
  store.recordRunStart({ id: runId, name: "claim-flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
  store.recordStageStart(runId, {
    id: "only", name: "only", status: "failed", parentIds: [], toolEvents: [],
    error: "login", failureKind: "auth", failureRecoverability: "recoverable",
    failureDisposition: "active_blocked", failureMessage: "login required",
  });
  store.recordRunBlocked(runId, "login", {
    failedStageId: "only", failureKind: "auth", failureRecoverability: "recoverable",
    failureDisposition: "active_blocked", failureMessage: "login required", resumable: true,
  });
  return store;
}

function registerBlockedDurable(backend: InMemoryDurableBackend, completedCheckpoints = 1) {
  backend.registerWorkflow({
    workflowId: runId, name: "claim-flow", inputs: {}, createdAt: 1,
    status: "blocked", completedCheckpoints, resumable: true,
  });
}

class FailingInvocationMetadataBackend extends InMemoryDurableBackend {
  override registerWorkflow(handle: Parameters<InMemoryDurableBackend["registerWorkflow"]>[0]): void {
    if (handle.workflowId !== runId && handle.invocationCwd !== undefined) {
      throw new Error("invocation metadata persistence failed");
    }
    super.registerWorkflow(handle);
  }
}

function claimFlow() {
  return workflow({
    name: "claim-flow", description: "", inputs: {}, outputs: {},
    run: async (ctx) => { await ctx.stage("only").prompt("go"); return {}; },
  });
}

describe("active-blocked resume claim", () => {
  test("dispatches a fresh-ID continuation and keeps the durable source blocked/resumable", async () => {
    const backend = new InMemoryDurableBackend();
    registerBlockedDurable(backend);
    setDurableBackend(backend);
    const store = seedBlockedRun();
    const jobs = createJobTracker();
    const runtime = createExtensionRuntime({
      registry: createRegistry([claimFlow()]), store, jobs,
      adapters: { prompt: { prompt: async () => "done" } },
    });

    const result = await runtime.resumeFailedRun(runId);
    assert.equal(result.ok, true);
    const continuationId = result.ok ? result.runId : "";
    // A fresh-ID continuation is dispatched (its id differs from the source).
    assert.notEqual(continuationId, runId);
    await jobs.get(continuationId)?.promise;

    // The durable source is left blocked/resumable (not mutated), so the work
    // stays recoverable if this process dies.
    assert.equal(backend.getWorkflow(runId)?.status, "blocked");
    assert.equal(backend.getWorkflow(runId)?.resumable, true);
    // The local source snapshot is killed (same-session routing won't re-resume).
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "killed");
    assert.equal(store.runs().find((run) => run.id === continuationId)?.status, "completed");
  });

  test("keeps a zero-checkpoint block recoverable (durable source unchanged)", () => {
    const backend = new InMemoryDurableBackend();
    registerBlockedDurable(backend, 0);
    // The source is a zero-progress blocked handle; leaving it untouched (rather
    // than claiming `running`) keeps it listed and recoverable.
    assert.deepEqual(backend.listResumableWorkflows().map((run) => run.workflowId), [runId]);
  });

  test("returns failure when the continuation's startup (run.start) fails, leaving the source resumable", async () => {
    const backend = new InMemoryDurableBackend();
    registerBlockedDurable(backend);
    setDurableBackend(backend);
    const store = seedBlockedRun();
    const jobs = createJobTracker();
    let callbacks = 0;
    const def = workflow({
      name: "claim-flow", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { callbacks += 1; await ctx.stage("only").prompt("go"); return {}; },
    });
    const runtime = createExtensionRuntime({
      registry: createRegistry([def]), store, jobs,
      adapters: { prompt: { prompt: async () => "done" } },
      persistence: {
        appendEntry(type) {
          if (type === "workflow.run.start") throw new Error("run.start persistence failed");
          return "entry";
        },
      },
    });

    const result = await runtime.resumeFailedRun(runId);

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /failed to start: run\.start persistence failed; source left resumable/u);
    assert.equal(callbacks, 0);
    // No orphan running continuation snapshot.
    assert.equal(store.runs().filter((run) => run.id !== runId).length, 0);
    // The source stays locally active-blocked/resumable so the same session can retry.
    const source = store.runs().find((run) => run.id === runId);
    assert.ok(source);
    assert.equal(source!.endedAt, undefined);
    assert.equal(backend.getWorkflow(runId)?.status, "blocked");
    assert.equal(backend.getWorkflow(runId)?.resumable, true);
  });

  test("leaves the source resumable when durable invocation metadata registration fails", async () => {
    const backend = new FailingInvocationMetadataBackend();
    registerBlockedDurable(backend);
    setDurableBackend(backend);
    const store = seedBlockedRun();
    const jobs = createJobTracker();
    let callbacks = 0;
    const def = workflow({
      name: "claim-flow", description: "", inputs: {}, outputs: {},
      run: async () => { callbacks += 1; return {}; },
    });
    const runtime = createExtensionRuntime({
      registry: createRegistry([def]), store, jobs,
      adapters: { prompt: { prompt: async () => "done" } },
    });

    const result = await runtime.resumeFailedRun(runId);

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /failed to start: invocation metadata persistence failed; source left resumable/u);
    assert.equal(callbacks, 0);
    assert.equal(store.runs().filter((run) => run.id !== runId).length, 0);
    const source = store.runs().find((run) => run.id === runId);
    assert.ok(source);
    assert.equal(source.endedAt, undefined);
    assert.equal(backend.getWorkflow(runId)?.status, "blocked");
    assert.equal(backend.getWorkflow(runId)?.resumable, true);
    assert.deepEqual(backend.listResumableWorkflows().map((run) => run.workflowId), [runId]);
  });

  test("refuses a concurrent second resume (one winner)", async () => {
    const backend = new InMemoryDurableBackend();
    registerBlockedDurable(backend);
    setDurableBackend(backend);
    const store = seedBlockedRun();
    const jobs = createJobTracker();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const def = workflow({
      name: "claim-flow", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { calls += 1; await ctx.stage("only").prompt("go"); return {}; },
    });
    const runtime = createExtensionRuntime({
      registry: createRegistry([def]), store, jobs,
      adapters: { prompt: { prompt: async () => { await held; return "done"; } } },
    });

    const first = await runtime.resumeFailedRun(runId);
    assert.equal(first.ok, true);
    // A second resume while the source is already killed locally is refused
    // (it no longer looks like an active-blocked run in this session).
    const second = await runtime.resumeFailedRun(runId);
    assert.equal(second.ok, false);

    release();
    const continuationId = first.ok ? first.runId : "";
    await jobs.get(continuationId)?.promise;
    assert.equal(calls, 1);
  });
});
