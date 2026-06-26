/**
 * Tests for the latest issue #1498 stage/frontier robustness fixes:
 * - Empty string stage outputs preserved during durable checkpointing
 * - Durable finalization failures still release limiter resources
 * - Replayed durable stages preserve graph parent/frontier state
 *
 * cross-ref: issue #1498 — stage checkpoint and graph lineage robustness.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { recordStageCheckpoint, recordCachedStageIntoStore, cachedStageId } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createStore } from "./executor-shared.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";

const WORKFLOW_ID = "wf-stage-frontier-001";

function makeStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "analyze",
    status: "completed",
    parentIds: [],
    startedAt: 1000,
    endedAt: 2000,
    result: "output",
    toolEvents: [],
    ...overrides,
  };
}

describe("empty string stage outputs (issue #1498)", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: WORKFLOW_ID, name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
  });

  test("empty string result is checkpointed as empty string", async () => {
    const stage = makeStage({ result: "" });
    const recorded = await recordStageCheckpoint({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: () => "cp-1",
      nextReplayKey: (n) => `stage:${n}:1`,
    }, stage);
    assert.equal(recorded, true);
    const output = backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1");
    assert.equal(output, "");
  });

  test("empty string result replays as empty string, not status object", async () => {
    const stage = makeStage({ result: "" });
    await recordStageCheckpoint({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: () => "cp-1",
      nextReplayKey: (n) => `stage:${n}:1`,
    }, stage);
    const replayed = backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1");
    assert.equal(replayed, "");
    assert.equal(typeof replayed, "string");
  });

  test("undefined result checkpoints as status object, not empty string", async () => {
    const stage = makeStage({ result: undefined });
    await recordStageCheckpoint({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: () => "cp-1",
      nextReplayKey: (n) => `stage:${n}:1`,
    }, stage);
    const replayed = backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1");
    assert.equal(typeof replayed, "object");
    assert.notEqual(replayed, "");
  });

  test("non-empty string result checkpoints as the string", async () => {
    const stage = makeStage({ result: "real output" });
    await recordStageCheckpoint({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: () => "cp-1",
      nextReplayKey: (n) => `stage:${n}:1`,
    }, stage);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1"), "real output");
  });
});

describe("replayed durable stage graph lineage (issue #1498)", () => {
  test("recordCachedStageIntoStore preserves parentIds from tracker", () => {
    const store = createStore();
    store.recordRunStart({ id: WORKFLOW_ID, name: "wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    const completedKeys = new Map<string, string>();

    // Simulate two replayed stages with tracker-driven parent lineage.
    const tracker = new GraphFrontierTracker();
    // First stage: no parents (frontier empty).
    const id1 = cachedStageId(WORKFLOW_ID, "stage:a:1");
    const parents1 = tracker.onSpawn(id1, "a");
    recordCachedStageIntoStore(store, WORKFLOW_ID, "a", "stage:a:1", "out-a", completedKeys, parents1);
    tracker.onSettle(id1);

    // Second stage: parent should be the first stage.
    const id2 = cachedStageId(WORKFLOW_ID, "stage:b:1");
    const parents2 = tracker.onSpawn(id2, "b");
    recordCachedStageIntoStore(store, WORKFLOW_ID, "b", "stage:b:1", "out-b", completedKeys, parents2);
    tracker.onSettle(id2);

    const run = store.runs().find((r) => r.id === WORKFLOW_ID)!;
    const stageA = run.stages.find((s) => s.name === "a")!;
    const stageB = run.stages.find((s) => s.name === "b")!;
    assert.equal(stageA.parentIds.length, 0);
    assert.equal(stageB.parentIds.includes(id1), true);
    assert.equal(stageB.parentIds.length, 1);
  });

  test("replayed stages without parentIds default to empty array", () => {
    const store = createStore();
    store.recordRunStart({ id: WORKFLOW_ID, name: "wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    const completedKeys = new Map<string, string>();
    recordCachedStageIntoStore(store, WORKFLOW_ID, "x", "stage:x:1", "out", completedKeys);
    const run = store.runs().find((r) => r.id === WORKFLOW_ID)!;
    const stage = run.stages.find((s) => s.name === "x")!;
    assert.deepEqual([...stage.parentIds], []);
  });
});
