/**
 * Multi-session concurrency: several Atomic processes sharing one DBOS
 * database. Covers per-process executor identity, foreign-live visibility,
 * and the first-writer-wins resume claim.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DbosDurableBackend,
  type DbosSdkHandle,
  type DbosStepRecord,
  type DbosWorkflowInfo,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import { getAtomicExecutorId } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import {
  FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
  isForeignLiveWorkflow,
} from "../../packages/workflows/src/durable/resume-eligibility.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

interface SharedDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  readonly steps: Map<string, WorkflowSerializableValue>;
}

/** DBOS-faithful shared mock: workflow/step ids are unique, first writer wins. */
function createSharedSdk(state: SharedDbosState): DbosSdkHandle {
  return {
    launch: async () => {},
    shutdown: async () => {},
    startWorkflow: async (workflowId, name, inputs) => {
      if (!state.workflows.has(workflowId)) {
        state.workflows.set(workflowId, { workflowId, name, status: "PENDING", createdAt: Date.now(), inputs });
      }
    },
    retrieveWorkflow: async (workflowId) => state.workflows.get(workflowId),
    cancelWorkflow: async () => {},
    resumeWorkflow: async () => {},
    listAllWorkflows: async () => [...state.workflows.values()],
    listStepRecords: async (workflowId) => {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) records.push({ stepName: key.slice(prefix.length), output });
      }
      return records;
    },
    recordStepOutput: async (workflowId, stepName, output) => {
      const key = `${workflowId}:checkpoint:${stepName}`;
      // DBOS checkpoint workflows are keyed by unique workflow id: a duplicate
      // record is an idempotent no-op and the first output remains durable.
      if (!state.steps.has(key)) state.steps.set(key, output);
    },
    deleteWorkflowData: async (workflowId) => {
      state.workflows.delete(workflowId);
      for (const key of [...state.steps.keys()]) {
        if (key.startsWith(`${workflowId}:checkpoint:`)) state.steps.delete(key);
      }
    },
  };
}

function seededMetadata(workflowId: string, overrides: Record<string, WorkflowSerializableValue>): WorkflowSerializableValue {
  return {
    __atomicDurableMetadata: true,
    version: 3,
    metadata: {
      workflowId,
      name: "multi-session-flow",
      inputs: {},
      status: "running",
      completedCheckpoints: 2,
      pendingPrompts: 0,
      createdAt: 1_000,
      promptReservationEpoch: "epoch",
      updatedAt: 2_000,
      ...overrides,
    },
  };
}

describe("per-process executor identity", () => {
  test("is unique, stable, and namespaced to this Atomic process", () => {
    assert.match(getAtomicExecutorId(), /^atomic-[0-9a-z]+-[0-9a-f]{8}$/);
    assert.equal(getAtomicExecutorId(), getAtomicExecutorId());
  });
});

describe("foreign-live workflow classification", () => {
  const local = getAtomicExecutorId();

  test("fresh running metadata owned by another executor is live elsewhere", () => {
    const now = Date.now();
    assert.equal(isForeignLiveWorkflow({ status: "running", updatedAt: now - 5_000, ownerExecutorId: "atomic-other-1" }, local, now), true);
  });

  test("stale, unowned, self-owned, and non-running handles are not foreign-live", () => {
    const now = Date.now();
    assert.equal(isForeignLiveWorkflow({ status: "running", updatedAt: now - FOREIGN_LIVE_WORKFLOW_WINDOW_MS - 1, ownerExecutorId: "atomic-other-1" }, local, now), false);
    assert.equal(isForeignLiveWorkflow({ status: "running", updatedAt: now, ownerExecutorId: undefined }, local, now), false);
    assert.equal(isForeignLiveWorkflow({ status: "running", updatedAt: now, ownerExecutorId: local }, local, now), false);
    assert.equal(isForeignLiveWorkflow({ status: "paused", updatedAt: now, ownerExecutorId: "atomic-other-1" }, local, now), false);
  });
});

describe("cross-process hydration of ordinary run checkpoints", () => {
  test("a completed run whose stage checkpoints omit topology stays visible in a fresh process", async () => {
    const state: SharedDbosState = { workflows: new Map(), steps: new Map() };
    const writer = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-a" });
    writer.registerWorkflow({
      workflowId: "wf-completed-run",
      name: "multi-session-flow",
      inputs: {},
      createdAt: 1,
      status: "running",
    });
    // Session-timing and direct-task writers emit stage-kind checkpoints
    // WITHOUT topology; the durable record must still be current-format.
    await writer.recordCheckpointAsync({
      kind: "stage",
      workflowId: "wf-completed-run",
      checkpointId: "stage-session:stage:task:echo:1:h123",
      name: "echo",
      replayKey: "stage:task:echo:1",
      sessionId: "session-1",
      sessionFile: "/tmp/echo.jsonl",
      completedAt: 10,
    });
    await writer.recordCheckpointAsync({
      kind: "stage",
      workflowId: "wf-completed-run",
      checkpointId: "task:stage:task:echo:1",
      name: "echo",
      replayKey: "stage:task:echo:1",
      output: { text: "pong" },
      completedAt: 11,
    });
    writer.setWorkflowStatus("wf-completed-run", "completed");
    await writer.flush();

    const fresh = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-b" });
    await fresh.hydrateResumableWorkflows();

    const handle = fresh.getWorkflow("wf-completed-run");
    assert.equal(handle?.status, "completed");
    assert.equal(fresh.isWorkflowLoadable("wf-completed-run"), true);
    assert.equal(fresh.listCheckpoints("wf-completed-run").length, 2);
    assert.deepEqual(fresh.listCompletedWorkflows().map((entry) => entry.workflowId), ["wf-completed-run"]);
    assert.equal(fresh.getStageOutput("wf-completed-run", "stage:task:echo:1") !== undefined, true);
  });
});

describe("running workflows are never resume targets", () => {
  test("a fresh-heartbeat running workflow is hidden even from its own session", async () => {
    const state: SharedDbosState = { workflows: new Map(), steps: new Map() };
    const owner = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-a" });
    owner.registerWorkflow({
      workflowId: "wf-own-running",
      name: "multi-session-flow",
      inputs: {},
      createdAt: 1,
      status: "running",
      completedCheckpoints: 3,
    });
    await owner.flush();

    assert.deepEqual(owner.listResumableWorkflows(), []);
    assert.equal(owner.getWorkflow("wf-own-running")?.status, "running");
  });
});

describe("shared-database visibility across sessions", () => {
  test("hides another session's live running workflow from resume, surfaces it once its heartbeat ages out", async () => {
    const state: SharedDbosState = { workflows: new Map(), steps: new Map() };
    state.workflows.set("wf-live-elsewhere", { workflowId: "wf-live-elsewhere", name: "multi-session-flow", status: "PENDING", createdAt: 1_000 });
    state.steps.set(
      "wf-live-elsewhere:checkpoint:__atomic_metadata:9000000000001:seed",
      seededMetadata("wf-live-elsewhere", { ownerExecutorId: "atomic-other-1", updatedAt: Date.now() }),
    );
    const observer = new DbosDurableBackend(createSharedSdk(state));
    await observer.hydrateResumableWorkflows();
    assert.deepEqual(observer.listResumableWorkflows(), []);
    assert.equal(observer.getWorkflow("wf-live-elsewhere")?.ownerExecutorId, "atomic-other-1");

    // The owning session crashes: nothing rewrites metadata and the recorded
    // heartbeat simply ages beyond the liveness window.
    const crashed: SharedDbosState = { workflows: new Map(), steps: new Map() };
    crashed.workflows.set("wf-crashed-elsewhere", { workflowId: "wf-crashed-elsewhere", name: "multi-session-flow", status: "PENDING", createdAt: 1_000 });
    crashed.steps.set(
      "wf-crashed-elsewhere:checkpoint:__atomic_metadata:9000000000001:seed",
      seededMetadata("wf-crashed-elsewhere", { workflowId: "wf-crashed-elsewhere", ownerExecutorId: "atomic-other-1", updatedAt: Date.now() - FOREIGN_LIVE_WORKFLOW_WINDOW_MS - 1 }),
    );
    const recoverer = new DbosDurableBackend(createSharedSdk(crashed));
    await recoverer.hydrateResumableWorkflows();
    assert.deepEqual(recoverer.listResumableWorkflows().map((entry) => entry.workflowId), ["wf-crashed-elsewhere"]);
  });

  test("resume refuses a workflow actively running in another session with an actionable message", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: "wf-foreign-live",
      name: "multi-session-flow",
      inputs: {},
      createdAt: 1,
      status: "running",
      completedCheckpoints: 3,
      ownerExecutorId: "atomic-other-1",
    });

    const result = await resumeDurableWorkflow("wf-foreign-live", {
      registry: { register: () => { throw new Error("unused"); }, merge: () => { throw new Error("unused"); }, get: () => undefined, has: () => false, remove: () => { throw new Error("unused"); }, names: () => [], all: () => [] },
      baseRunOpts: { store: createStore() },
      durableBackend: backend,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /actively running in another Atomic session/);
  });
});

describe("cross-process resume claim", () => {
  async function pausedWorkflowState(): Promise<SharedDbosState> {
    const state: SharedDbosState = { workflows: new Map(), steps: new Map() };
    const seeder = new DbosDurableBackend(createSharedSdk(state));
    seeder.registerWorkflow({
      workflowId: "wf-contended",
      name: "multi-session-flow",
      inputs: {},
      createdAt: 1,
      status: "paused",
      completedCheckpoints: 2,
    });
    await seeder.flush();
    return state;
  }

  test("exactly one of two sessions wins the paused→running transition", async () => {
    const state = await pausedWorkflowState();
    const sessionA = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-a" });
    const sessionB = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-b" });
    await sessionA.hydrateWorkflow("wf-contended");
    await sessionB.hydrateWorkflow("wf-contended");

    const outcomes = await Promise.all([
      sessionA.transitionWorkflowStatus("wf-contended", ["paused"], "running"),
      sessionB.transitionWorkflowStatus("wf-contended", ["paused"], "running"),
    ]);

    assert.deepEqual([...outcomes].sort(), [false, true]);
  });

  test("the losing session reconciles to the authoritative running state", async () => {
    const state = await pausedWorkflowState();
    const winner = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-a" });
    const loser = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-b" });
    await winner.hydrateWorkflow("wf-contended");
    await loser.hydrateWorkflow("wf-contended");

    assert.equal(await winner.transitionWorkflowStatus("wf-contended", ["paused"], "running"), true);
    assert.equal(await loser.transitionWorkflowStatus("wf-contended", ["paused"], "running"), false);
    assert.equal(loser.getWorkflow("wf-contended")?.status, "running");
  });

  test("a crashed winner cannot wedge the generation: its claim is valid metadata", async () => {
    const state = await pausedWorkflowState();
    // Session A wins the claim but "crashes" before dispatching its write.
    const crasher = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-a" });
    await crasher.hydrateWorkflow("wf-contended");
    assert.equal(await crasher.transitionWorkflowStatus("wf-contended", ["paused"], "running"), true);

    // A fresh session hydrates the claim as authoritative running metadata
    // owned by the dead executor — recoverable via heartbeat staleness, and
    // the workflow remains loadable rather than suppressed.
    const fresh = new DbosDurableBackend(createSharedSdk(state), { executorId: "atomic-session-b" });
    await fresh.hydrateWorkflow("wf-contended");
    assert.equal(fresh.getWorkflow("wf-contended")?.status, "running");
    assert.equal(fresh.getWorkflow("wf-contended")?.ownerExecutorId, "atomic-session-a");
    assert.equal(fresh.isWorkflowLoadable("wf-contended"), true);
  });
});
