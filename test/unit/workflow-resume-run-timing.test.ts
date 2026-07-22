import { describe } from "bun:test";
import { assert, createStore, run, test, Type, workflow } from "./executor-shared.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
  RUN_TIMING_CHECKPOINT_NAME,
  inheritedRunElapsedMs,
  priorRunElapsedMs,
  recordRunTimingCheckpoint,
} from "../../packages/workflows/src/durable/run-timing.js";
import { recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { classifyCheckpointPayload, encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { getDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { finalizeDurableTerminalStatus } from "../../packages/workflows/src/engine/run-durable-finalize.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { elapsedRunMs } from "../../packages/workflows/src/shared/timing.js";
import { appendRunStart } from "../../packages/workflows/src/shared/persistence-session-entries.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

const RUN_ID = "wf-run-timing";

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    name: "timing",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: 0,
    ...overrides,
  };
}

function makeBackend(): InMemoryDurableBackend {
  const backend = new InMemoryDurableBackend();
  backend.registerWorkflow({ workflowId: RUN_ID, name: "timing", inputs: {}, createdAt: 1, status: "running" });
  return backend;
}

function recordProgressCheckpoint(backend: InMemoryDurableBackend, workflowId = RUN_ID): void {
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: "stage-session:stage:work:1:seed",
    name: "work",
    replayKey: "stage:work:1",
    sessionFile: "/tmp/work.jsonl",
    startedAt: 2,
    durationMs: 700,
    completedAt: 5,
  });
}

describe("run timer math with inherited elapsed", () => {
  test("elapsedRunMs adds accumulated elapsed from prior sessions", () => {
    const resumed = makeRun({ startedAt: 1000, accumulatedDurationMs: 500 });
    assert.equal(elapsedRunMs(resumed, 1600), 1100);
  });

  test("accumulated elapsed composes with pause accounting without double counting", () => {
    const resumed = makeRun({
      startedAt: 1000,
      accumulatedDurationMs: 500,
      pausedDurationMs: 200,
      pausedAt: 1800,
    });
    // 500 inherited + (2000 - 1000 - 200 completed pause - 200 active pause)
    assert.equal(elapsedRunMs(resumed, 2000), 1100);
  });

  test("terminal durationMs wins over accumulated elapsed", () => {
    const ended = makeRun({ startedAt: 1000, durationMs: 42, accumulatedDurationMs: 500 });
    assert.equal(elapsedRunMs(ended, 9999), 42);
  });
});

describe("durable run-timing checkpoints", () => {
  test("records run elapsed only once the workflow has durable progress", () => {
    const backend = makeBackend();
    const snapshot = makeRun({ startedAt: 0 });
    assert.equal(recordRunTimingCheckpoint(backend, snapshot, { now: 10_000 }), false);
    assert.equal(priorRunElapsedMs(backend, RUN_ID), undefined);

    recordProgressCheckpoint(backend);
    assert.equal(recordRunTimingCheckpoint(backend, snapshot, { now: 10_000 }), true);
    assert.equal(priorRunElapsedMs(backend, RUN_ID), 10_000);
  });

  test("debounces inside a 30s bucket and refreshes across buckets", () => {
    const backend = makeBackend();
    recordProgressCheckpoint(backend);
    const snapshot = makeRun({ startedAt: 0 });
    assert.equal(recordRunTimingCheckpoint(backend, snapshot, { now: 10_000, debounce: true }), true);
    assert.equal(recordRunTimingCheckpoint(backend, snapshot, { now: 20_000, debounce: true }), false);
    assert.equal(priorRunElapsedMs(backend, RUN_ID), 10_000);
    assert.equal(recordRunTimingCheckpoint(backend, snapshot, { now: 40_000, debounce: true }), true);
    assert.equal(priorRunElapsedMs(backend, RUN_ID), 40_000);
  });

  test("never regresses the recorded elapsed", () => {
    const backend = makeBackend();
    recordProgressCheckpoint(backend);
    assert.equal(recordRunTimingCheckpoint(backend, makeRun({ startedAt: 0 }), { now: 40_000 }), true);
    // A snapshot with a smaller elapsed value must not overwrite the record.
    assert.equal(recordRunTimingCheckpoint(backend, makeRun({ startedAt: 39_000 }), { now: 40_000 }), false);
    assert.equal(priorRunElapsedMs(backend, RUN_ID), 40_000);
  });

  test("round-trips through the DBOS checkpoint envelope into a fresh process", () => {
    const backend = makeBackend();
    recordProgressCheckpoint(backend);
    assert.equal(recordRunTimingCheckpoint(backend, makeRun({ startedAt: 0 }), { now: 90_000 }), true);
    const checkpoint = backend.listCheckpoints(RUN_ID)
      .find((candidate) => candidate.kind === "tool" && candidate.name === RUN_TIMING_CHECKPOINT_NAME);
    assert.ok(checkpoint !== undefined);

    const envelope = encodeCheckpoint(checkpoint) as WorkflowSerializableValue;
    const classified = classifyCheckpointPayload(RUN_ID, checkpoint.checkpointId, envelope);
    assert.equal(classified.kind, "current");

    const rehydrated = makeBackend();
    if (classified.kind === "current") rehydrated.recordCheckpoint(classified.checkpoint);
    assert.equal(priorRunElapsedMs(rehydrated, RUN_ID), 90_000);
  });

  test("inheritedRunElapsedMs prefers the live continuation source snapshot", () => {
    const backend = makeBackend();
    const source = makeRun({ startedAt: 1000, endedAt: 2000, durationMs: 1234, status: "failed" });
    assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID, continuationSource: source }), 1234);
    assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID }), undefined);

    recordProgressCheckpoint(backend);
    recordRunTimingCheckpoint(backend, makeRun({ startedAt: 0 }), { now: 5_000 });
    assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID }), 5_000);
  });
});


describe("stage timing durability boundaries", () => {
  test("forced sub-30-second checkpoint records exact elapsed and topology", async () => {
    const backend = makeBackend();
    const deps = {
      workflowId: RUN_ID,
      backend,
      nextCheckpointId: () => "unused",
      nextReplayKey: () => "stage:work:1",
      now: () => 10_000,
      runTopology: { runId: RUN_ID, runName: "timing" },
    };
    const stage = {
      id: "work-source", name: "work", replayKey: "stage:work:1", status: "paused" as const,
      parentIds: ["plan-source"], startedAt: 0, pausedAt: 10_000,
      sessionFile: "/tmp/work.jsonl", toolEvents: [],
    };
    assert.equal(await recordStageSessionCheckpoint(deps, stage), true);
    deps.now = () => 20_000;
    stage.pausedAt = 20_000;
    assert.equal(await recordStageSessionCheckpoint(deps, stage), false, "ordinary updates remain bucketed");
    assert.equal(await recordStageSessionCheckpoint(deps, stage, { force: true }), true);
    const restored = backend.getStageSession(RUN_ID, "stage:work:1");
    assert.equal(restored?.durationMs, 20_000);
    const latest = backend.listCheckpoints(RUN_ID).filter((checkpoint) => checkpoint.kind === "stage").at(-1);
    assert.deepEqual(latest?.topology, {
      version: 1,
      stageId: "work-source",
      parentIds: ["plan-source"],
      run: { runId: RUN_ID, runName: "timing" },
    });
  });
});
describe("resumed runs inherit elapsed time", () => {
  test("durable resume seeds run total and mid-running stage timers", async () => {
    const runId = "wf-durable-resume-timing";
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: runId, name: "timing", inputs: {}, createdAt: 1, status: "paused" });
    // Mid-running stage session persisted by the prior session (700ms elapsed).
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: runId,
      checkpointId: "stage-session:stage:work:1:prior",
      name: "work",
      replayKey: "stage:work:1",
      sessionFile: "/tmp/prior.jsonl",
      startedAt: 2,
      durationMs: 700,
      completedAt: 5,
    });
    // Total run elapsed persisted at quit time (90s).
    backend.recordCheckpoint({
      kind: "tool",
      workflowId: runId,
      checkpointId: "run-timing:90000",
      name: RUN_TIMING_CHECKPOINT_NAME,
      argsHash: RUN_TIMING_CHECKPOINT_NAME,
      output: { elapsedMs: 90_000 },
      completedAt: 6,
    });

    const store = createStore();
    const def = workflow({
      name: "timing",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: await ctx.stage("work").complete("continue") }),
    });
    const result = await run(def, {}, {
      runId,
      store,
      durableBackend: backend,
      adapters: { complete: { complete: async (text: string) => text } },
    });

    assert.equal(result.status, "completed");
    const snapshot = store.runs().find((candidate) => candidate.id === runId);
    assert.equal(snapshot?.accumulatedDurationMs, 90_000);
    // Total workflow duration includes the prior 90s, not just this session.
    assert.ok((snapshot?.durationMs ?? 0) >= 90_000);
    // The resumed mid-running stage timer continues from its prior 700ms.
    const stage = snapshot?.stages.find((candidate) => candidate.name === "work");
    assert.ok((stage?.durationMs ?? 0) >= 700);
  });

  test("continuation resume inherits the source run's total elapsed", async () => {
    const store = createStore();
    const def = workflow({
      name: "cont-timing",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: await ctx.stage("work").complete("go") }),
    });

    const first = await run(def, {}, {
      store,
      adapters: { complete: { complete: async () => { throw new Error("boom"); } } },
    });
    assert.equal(first.status, "failed");
    const source = store.runs().find((candidate) => candidate.id === first.runId)!;
    // Deterministic prior total for the assertion below.
    source.durationMs = 4321;

    const continued = await run(def, {}, {
      store,
      continuation: { source, resumeFromStageId: source.failedStageId! },
      adapters: { complete: { complete: async (text: string) => text } },
    });

    assert.equal(continued.status, "completed");
    const snapshot = store.runs().find((candidate) => candidate.id === continued.runId);
    assert.equal(snapshot?.accumulatedDurationMs, 4321);
    assert.ok((snapshot?.durationMs ?? 0) >= 4321);
  });
});

describe("run elapsed persistence at pause/failure boundaries", () => {
  test("quitRun persists the exact accumulated run elapsed durably", async () => {
    const backend = getDurableBackend();
    const runId = "wf-quit-timing";
    backend.registerWorkflow({ workflowId: runId, name: "timing", inputs: {}, createdAt: 1, status: "running" });
    recordProgressCheckpoint(backend as InMemoryDurableBackend, runId);

    const store = createStore();
    const startedAt = Date.now() - 60_000;
    store.recordRunStart(makeRun({ id: runId, startedAt }));
    // Freeze the live clock contribution: an already-paused run accrues
    // exactly pausedAt - startedAt elapsed regardless of when quit lands.
    store.recordRunPaused(runId, startedAt + 8_000);

    const result = await quitRun(runId, { store });
    assert.equal(result.ok, true);
    assert.equal(priorRunElapsedMs(backend, runId), 8_000);
  });

  test("terminal failure finalize persists the exact accumulated elapsed", async () => {
    const backend = makeBackend();
    recordProgressCheckpoint(backend);
    const snapshot = makeRun({
      status: "failed",
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 5555,
      resumable: true,
    });

    await finalizeDurableTerminalStatus({ runId: RUN_ID, runSnapshot: snapshot, isRoot: true, durableBackend: backend });

    assert.equal(priorRunElapsedMs(backend, RUN_ID), 5555);
    assert.equal(backend.getWorkflow(RUN_ID)?.status, "failed");
  });
});

describe("run.start persistence round-trip", () => {
  test("restores inherited elapsed onto the rehydrated run snapshot", () => {
    const entries: SessionEntry[] = [];
    const api = {
      appendEntry: (type: string, payload: Record<string, unknown>): string => {
        entries.push({ id: `entry-${entries.length}`, type, payload: payload as SessionEntry["payload"] });
        return `entry-${entries.length}`;
      },
    };
    appendRunStart(api, { runId: "restored-run", name: "timing", inputs: {}, accumulatedDurationMs: 7777, ts: 1000 });

    const store = createStore();
    restoreOnSessionStart(
      { getEntries: () => entries },
      { resumeInFlight: "auto", persistRuns: true },
      store,
    );

    const restored = store.runs().find((candidate) => candidate.id === "restored-run");
    assert.equal(restored?.accumulatedDurationMs, 7777);
    assert.equal(elapsedRunMs(restored!, 1500), 7777 + 500);
  });
});
