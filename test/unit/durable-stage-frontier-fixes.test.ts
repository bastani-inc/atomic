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
import { recordStageCheckpoint, recordCachedStageIntoStore, recordCachedStageWithTracker, cachedStageId, type DurableCompletedStageCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
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

  test("parallel replay uses fail-fast scope parents instead of flattening fanout", () => {
    const store = createStore();
    store.recordRunStart({ id: WORKFLOW_ID, name: "wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    const completedKeys = new Map<string, string>();
    const tracker = new GraphFrontierTracker();

    const setup: DurableCompletedStageCheckpoint = {
      kind: "stage", workflowId: WORKFLOW_ID, checkpointId: "stage:setup:1", name: "setup",
      replayKey: "stage:setup:1", output: "ready", completedAt: 1100, result: "ready",
    };
    recordCachedStageWithTracker(store, tracker, WORKFLOW_ID, "setup", setup.replayKey, setup, completedKeys);
    const setupId = cachedStageId(WORKFLOW_ID, setup.replayKey);
    const parallelScope = { failed: false, activeStages: new Map(), parentIds: Object.freeze([setupId]) };

    for (const name of ["review-a", "review-b"]) {
      const cp: DurableCompletedStageCheckpoint = {
        kind: "stage", workflowId: WORKFLOW_ID, checkpointId: `task:stage:task:${name}:1`, name,
        replayKey: `stage:task:${name}:1`, output: { name, stageName: name, text: `${name} done` },
        completedAt: 1200, result: `${name} done`,
        topology: name === "review-a"
          ? { version: 1, stageId: cpStageId(name), parentIds: [] }
          : { version: 1, stageId: cpStageId(name), parentIds: ["missing-source-parent"], run: { runId: WORKFLOW_ID, runName: "wf" } },
      };
      recordCachedStageWithTracker(store, tracker, WORKFLOW_ID, name, cp.replayKey, cp, completedKeys, parallelScope);
    }

    const run = store.runs().find((r) => r.id === WORKFLOW_ID)!;
    const reviewers = run.stages.filter((stage) => stage.name.startsWith("review-"));
    assert.equal(reviewers.length, 2);
    for (const reviewer of reviewers) assert.deepEqual([...reviewer.parentIds], [setupId]);
  });


  function cpStageId(name: string): string { return `checkpoint-only:${name}`; }
  test("cached replay hydrates persisted stage timing, result, session, and model + thinking metadata", () => {
    const store = createStore();
    store.recordRunStart({ id: WORKFLOW_ID, name: "wf", inputs: {}, status: "running", stages: [], startedAt: Date.now() });
    const completedKeys = new Map<string, string>();
    const cp: DurableCompletedStageCheckpoint = {
      kind: "stage", workflowId: WORKFLOW_ID, checkpointId: "stage:hydrate:1", name: "hydrate",
      replayKey: "stage:hydrate:1", output: { structured: true }, completedAt: 2500,
      startedAt: 1000, endedAt: 2500, durationMs: 1500, result: "persisted summary",
      sessionId: "sid", sessionFile: "/tmp/session.jsonl", model: "gpt-test", fastMode: true,
      thinkingLevel: "high",
      attemptedModels: ["gpt-test"], modelAttempts: [{ model: "gpt-test", success: true }],
    };

    recordCachedStageIntoStore(store, WORKFLOW_ID, "hydrate", cp.replayKey, cp.output, completedKeys, [], cp);
    const stage = store.runs().find((r) => r.id === WORKFLOW_ID)!.stages[0]!;
    assert.equal(stage.startedAt, 1000);
    assert.equal(stage.endedAt, 2500);
    assert.equal(stage.durationMs, 1500);
    assert.equal(stage.result, "persisted summary");
    assert.equal(stage.sessionId, "sid");
    assert.equal(stage.sessionFile, "/tmp/session.jsonl");
    assert.equal(stage.model, "gpt-test");
    assert.equal(stage.thinkingLevel, "high");
    assert.equal(stage.fastMode, true);
    assert.deepEqual(stage.attemptedModels, ["gpt-test"]);
    assert.equal(stage.modelAttempts?.[0]?.success, true);
  });
