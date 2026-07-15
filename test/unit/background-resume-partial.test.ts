import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import {
  createStageControlRegistry,
  type StageControlHandle,
  type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface ResumeHandleState {
  status: StageControlStatus;
  calls: number;
}

function seedPausedRun(
  runId: string,
  stageIds: readonly string[],
  backend: InMemoryDurableBackend = new InMemoryDurableBackend(),
) {
  const store = createStore();
  store.recordRunStart({ id: runId, name: "partial", inputs: {}, status: "running", stages: [], startedAt: 1 });
  for (const stageId of stageIds) {
    store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
    store.recordStagePaused(runId, stageId);
  }
  store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
  backend.registerWorkflow({ workflowId: runId, name: "partial", inputs: {}, createdAt: 1, status: "paused" });
  backend.recordCheckpoint({
    kind: "tool",
    workflowId: runId,
    checkpointId: "progress",
    name: "progress",
    argsHash: "progress",
    output: "done",
    completedAt: 2,
  });
  setDurableBackend(backend);
  return { store, backend, registry: createStageControlRegistry() };
}

function registerProductionShapedHandle(input: {
  readonly runId: string;
  readonly stageId: string;
  readonly state: ResumeHandleState;
  readonly store: ReturnType<typeof createStore>;
  readonly registry: ReturnType<typeof createStageControlRegistry>;
  readonly resume: () => Promise<void>;
}): StageControlHandle {
  const handle: StageControlHandle = {
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageId,
    get status() { return input.state.status; },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt() {},
    async steer() {},
    async followUp() {},
    async pause() {
      input.state.status = "paused";
      input.store.recordStagePaused(input.runId, input.stageId);
    },
    async resume() {
      input.state.calls += 1;
      await input.resume();
    },
    subscribe: () => () => {},
  };
  input.registry.register(handle);
  return handle;
}

afterEach(() => setDurableBackend(undefined));

describe("multi-stage resume acknowledgement coherence", () => {
  test("settles every stage and reports partial running state before a later retry", async () => {
    const runId = "partial-resume-all-settled";
    const { store, backend, registry } = seedPausedRun(runId, ["reject-first", "resume-late"]);
    const rejected: ResumeHandleState = { status: "paused", calls: 0 };
    const resumed: ResumeHandleState = { status: "paused", calls: 0 };
    const lateSuccess = Promise.withResolvers<void>();
    let rejectFirst = true;
    let retryCalls = 0;
    registerProductionShapedHandle({
      runId,
      stageId: "reject-first",
      state: rejected,
      store,
      registry,
      resume: async () => {
        if (rejectFirst) throw new Error("first resume failed");
        retryCalls += 1;
        rejected.status = "running";
        store.recordStageResumed(runId, "reject-first");
        store.recordRunResumed(runId);
      },
    });
    registerProductionShapedHandle({
      runId,
      stageId: "resume-late",
      state: resumed,
      store,
      registry,
      resume: async () => {
        await lateSuccess.promise;
        resumed.status = "running";
        store.recordStageResumed(runId, "resume-late");
        store.recordRunResumed(runId);
      },
    });

    const outcome = resumeRun(runId, { store, stageControlRegistry: registry })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual([rejected.calls, resumed.calls], [1, 1], "every resume must be attempted before settlement");
    lateSuccess.resolve();
    const first = await outcome;

    assert.ok("result" in first);
    assert.equal(first.result.ok, true);
    if (!first.result.ok) return;
    assert.equal(first.result.mode, "partial");
    assert.deepEqual(first.result.resumed.map((stage) => stage.id), ["resume-late"]);
    assert.match(first.result.message ?? "", /partial/i);
    assert.match(first.result.message ?? "", new RegExp(`${runId}/reject-first.*first resume failed`));
    assert.equal(first.result.snapshot.status, "running");
    assert.deepEqual(first.result.snapshot.stages.map((stage) => stage.status), ["paused", "running"]);
    assert.equal(backend.getWorkflow(runId)?.status, "running");

    rejectFirst = false;
    rejected.status = "paused";
    const retried = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(retried.ok, true);
    assert.equal(retryCalls, 1);
    if (retried.ok) assert.deepEqual(retried.resumed.map((stage) => stage.id), ["reject-first"]);
    assert.deepEqual(store.runs().find((run) => run.id === runId)?.stages.map((stage) => stage.status), ["running", "running"]);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("waits for a late rejection after an earlier stage visibly resumes", async () => {
    const runId = "resume-late-rejection";
    const { store, backend, registry } = seedPausedRun(runId, ["resume-first", "reject-late"]);
    const first: ResumeHandleState = { status: "paused", calls: 0 };
    const late: ResumeHandleState = { status: "paused", calls: 0 };
    const lateAcknowledgement = Promise.withResolvers<void>();
    registerProductionShapedHandle({
      runId,
      stageId: "resume-first",
      state: first,
      store,
      registry,
      resume: async () => {
        first.status = "running";
        store.recordStageResumed(runId, "resume-first");
        store.recordRunResumed(runId);
      },
    });
    registerProductionShapedHandle({
      runId,
      stageId: "reject-late",
      state: late,
      store,
      registry,
      resume: async () => {
        await lateAcknowledgement.promise;
        throw new Error("late resume failed");
      },
    });

    let settled = false;
    const operation = resumeRun(runId, { store, stageControlRegistry: registry })
      .finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual([first.calls, late.calls], [1, 1]);
    assert.equal(settled, false);
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
    lateAcknowledgement.resolve();

    const result = await operation;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "partial");
      assert.match(result.message ?? "", new RegExp(runId + "/reject-late.*late resume failed"));
    }
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("counts a late rejection as resumed after its stage is visibly running", async () => {
    const runId = "resume-late-visible";
    const { store, backend, registry } = seedPausedRun(runId, ["ok", "late-visible"]);
    for (const stageId of ["ok", "late-visible"] as const) {
      const state: ResumeHandleState = { status: "paused", calls: 0 };
      registerProductionShapedHandle({
        runId,
        stageId,
        state,
        store,
        registry,
        resume: async () => {
          state.status = "running";
          store.recordStageResumed(runId, stageId);
          store.recordRunResumed(runId);
          if (stageId === "late-visible") throw new Error("late failure after visible resume");
        },
      });
    }

    const result = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.resumed.map((stage) => stage.id), ["ok", "late-visible"]);
    assert.deepEqual(result.snapshot.stages.map((stage) => stage.status), ["running", "running"]);
    assert.doesNotMatch(result.message ?? "", /remain resumable/i);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
    const retried = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(retried.ok, true);
    if (retried.ok) assert.equal(retried.resumed.length, 0);
  });

  test("reconciles a late-rejecting running control into the store", async () => {
    const runId = "resume-late-control-visible";
    const { store, backend, registry } = seedPausedRun(runId, ["control-visible"]);
    const state: ResumeHandleState = { status: "paused", calls: 0 };
    registerProductionShapedHandle({
      runId,
      stageId: "control-visible",
      state,
      store,
      registry,
      resume: async () => {
        state.status = "running";
        throw new Error("late control failure");
      },
    });

    const result = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.resumed.map((stage) => stage.id), ["control-visible"]);
    assert.equal(result.snapshot.stages[0]?.status, "running");
    assert.equal(result.snapshot.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("all late-visible rejections reconcile the root and durability to running", async () => {
    const runId = "resume-all-late-visible";
    const { store, backend, registry } = seedPausedRun(runId, ["late-a", "late-b"]);
    for (const stageId of ["late-a", "late-b"] as const) {
      const state: ResumeHandleState = { status: "paused", calls: 0 };
      registerProductionShapedHandle({
        runId,
        stageId,
        state,
        store,
        registry,
        resume: async () => {
          state.status = "running";
          store.recordStageResumed(runId, stageId);
          throw new Error(`cascade failed ${stageId}`);
        },
      });
    }

    const result = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.resumed.map((stage) => stage.id), ["late-a", "late-b"]);
    assert.equal(result.snapshot.status, "running");
    assert.deepEqual(result.snapshot.stages.map((stage) => stage.status), ["running", "running"]);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("terminalization during acknowledgement cannot revive a stage", async () => {
    const runId = "resume-terminal-race";
    const { store, backend, registry } = seedPausedRun(runId, ["racing-stage"]);
    const state: ResumeHandleState = { status: "paused", calls: 0 };
    const acknowledgement = Promise.withResolvers<void>();
    registerProductionShapedHandle({
      runId,
      stageId: "racing-stage",
      state,
      store,
      registry,
      resume: async () => {
        await acknowledgement.promise;
        state.status = "running";
        store.recordStageResumed(runId, "racing-stage");
      },
    });

    const operation = resumeRun(runId, { store, stageControlRegistry: registry });
    await Promise.resolve();
    assert.equal(store.recordRunEnd(runId, "completed", {}), true);
    backend.setWorkflowStatus(runId, "completed");
    acknowledgement.resolve();
    const result = await operation;
    assert.equal(result.ok, true);
    const terminal = store.runs().find((run) => run.id === runId);
    assert.equal(terminal?.status, "completed");
    assert.notEqual(terminal?.stages[0]?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "completed");
  });

  test("aggregates all stage-qualified failures and leaves all-paused state coherent", async () => {
    const runId = "resume-all-reject";
    const { store, backend, registry } = seedPausedRun(runId, ["reject-a", "reject-b"]);
    for (const [stageId, message] of [["reject-a", "alpha"], ["reject-b", "beta"]] as const) {
      registerProductionShapedHandle({
        runId,
        stageId,
        state: { status: "paused", calls: 0 },
        store,
        registry,
        resume: async () => { throw new Error(message); },
      });
    }

    await assert.rejects(
      resumeRun(runId, { store, stageControlRegistry: registry }),
      new RegExp(`${runId}/reject-a.*alpha.*${runId}/reject-b.*beta`),
    );
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");
    assert.deepEqual(store.runs().find((run) => run.id === runId)?.stages.map((stage) => stage.status), ["paused", "paused"]);
    assert.equal(backend.getWorkflow(runId)?.status, "paused");
  });

  test("surfaces durable running transition and flush failures after visible resume", async () => {
    class ThrowRunningBackend extends InMemoryDurableBackend {
      override setWorkflowStatus(
        workflowId: string,
        status: Parameters<InMemoryDurableBackend["setWorkflowStatus"]>[1],
        pendingPrompts?: number,
        resumable?: boolean,
      ): void {
        if (status === "running") throw new Error("durable running write failed");
        super.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      }
    }
    class ThrowFlushBackend extends InMemoryDurableBackend {
      async flush(): Promise<void> { throw new Error("durable running flush failed"); }
    }
    for (const [suffix, backend, failure] of [
      ["set", new ThrowRunningBackend(), /durable running write failed/],
      ["flush", new ThrowFlushBackend(), /durable running flush failed/],
    ] as const) {
      const runId = `resume-durable-failure-${suffix}`;
      const seeded = seedPausedRun(runId, ["only"], backend);
      const state: ResumeHandleState = { status: "paused", calls: 0 };
      registerProductionShapedHandle({
        runId,
        stageId: "only",
        state,
        store: seeded.store,
        registry: seeded.registry,
        resume: async () => {
          state.status = "running";
          seeded.store.recordStageResumed(runId, "only");
          seeded.store.recordRunResumed(runId);
        },
      });

      const result = await resumeRun(runId, { store: seeded.store, stageControlRegistry: seeded.registry });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.mode, "partial");
        assert.match(result.message ?? "", failure);
      }
      assert.equal(seeded.store.runs().find((run) => run.id === runId)?.stages[0]?.status, "running");
    }
  });

  test("retries a failed durable running transition after local resume already succeeded", async () => {
    class TransientRunningBackend extends InMemoryDurableBackend {
      runningAttempts = 0;
      override setWorkflowStatus(
        workflowId: string,
        status: Parameters<InMemoryDurableBackend["setWorkflowStatus"]>[1],
        pendingPrompts?: number,
        resumable?: boolean,
      ): void {
        if (status === "running" && ++this.runningAttempts === 1) throw new Error("transient durable failure");
        super.setWorkflowStatus(workflowId, status, pendingPrompts, resumable);
      }
    }
    const runId = "resume-durable-retry";
    const backend = new TransientRunningBackend();
    const { store, registry } = seedPausedRun(runId, ["only"], backend);
    const state: ResumeHandleState = { status: "paused", calls: 0 };
    registerProductionShapedHandle({
      runId, stageId: "only", state, store, registry,
      resume: async () => {
        state.status = "running";
        store.recordStageResumed(runId, "only");
        store.recordRunResumed(runId);
      },
    });

    const first = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.mode, "partial");
      assert.equal(first.runId, runId);
      assert.deepEqual(first.resumed.map((stage) => stage.id), ["only"]);
      assert.match(first.message ?? "", /transient durable failure/);
    }
    assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
    assert.equal(backend.getWorkflow(runId)?.status, "paused");

    const second = await resumeRun(runId, { store, stageControlRegistry: registry });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.runId, runId);
      assert.equal(second.mode, "snapshot");
      assert.deepEqual(second.resumed, []);
    }
    assert.equal(backend.runningAttempts, 2);
    assert.equal(backend.getWorkflow(runId)?.status, "running");
  });

  test("successful resume preserves target order despite reverse settlement", async () => {
    const runId = "resume-success-order";
    const { store, registry } = seedPausedRun(runId, ["stage-a", "stage-b"]);
    const a = Promise.withResolvers<void>();
    const b = Promise.withResolvers<void>();
    for (const [stageId, acknowledgement] of [["stage-a", a], ["stage-b", b]] as const) {
      const state: ResumeHandleState = { status: "paused", calls: 0 };
      registerProductionShapedHandle({
        runId,
        stageId,
        state,
        store,
        registry,
        resume: async () => {
          await acknowledgement.promise;
          state.status = "running";
          store.recordStageResumed(runId, stageId);
          store.recordRunResumed(runId);
        },
      });
    }

    const operation = resumeRun(runId, { store, stageControlRegistry: registry });
    await Promise.resolve();
    b.resolve();
    await Promise.resolve();
    a.resolve();
    const result = await operation;
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.resumed.map((stage) => stage.id), ["stage-a", "stage-b"]);
  });
});
