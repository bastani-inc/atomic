/**
 * Tests for the durable ctx.stage/ctx.task checkpoint recorder.
 *
 * Verifies completed stage outputs are recorded durably at the stage-end
 * lifecycle boundary and are idempotent.
 *
 * cross-ref: issue #1498 — durable stage/task checkpoints.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { recordStageCheckpoint, createStageReplayKeyGenerator } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const WORKFLOW_ID = "wf-stage-test-001";

function makeStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "analyze",
    status: "completed",
    parentIds: [],
    startedAt: 1000,
    endedAt: 2000,
    result: "analysis output",
    toolEvents: [],
    ...overrides,
  };
}

describe("recordStageCheckpoint", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "stage-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
  });

  function deps() {
    return {
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
    };
  }

  test("records completed stage output", () => {
    const recorded = recordStageCheckpoint(deps(), makeStage());
    assert.equal(recorded, true);
    const replayKey = createStageReplayKeyGenerator(WORKFLOW_ID)("analyze", "stage-1");
    assert.equal(backend.getStageOutput(WORKFLOW_ID, replayKey), "analysis output");
  });

  test("prefers stage.replayKey when present", () => {
    const stage = makeStage({ replayKey: "continuation:analyze:1" });
    recordStageCheckpoint(deps(), stage);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "continuation:analyze:1"), "analysis output");
  });

  test("skips non-completed stages", () => {
    const stage = makeStage({ status: "running" });
    assert.equal(recordStageCheckpoint(deps(), stage), false);
  });

  test("idempotent — recording the same stage twice is a no-op", () => {
    const d = deps();
    recordStageCheckpoint(d, makeStage({ replayKey: "rk-1" }));
    recordStageCheckpoint(d, makeStage({ replayKey: "rk-1", result: "DIFFERENT" }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "rk-1"), "analysis output");
    assert.equal(backend.getWorkflow(WORKFLOW_ID)!.completedCheckpoints, 1);
  });

  test("falls back to status marker when result is empty", () => {
    const stage = makeStage({ result: undefined, replayKey: "rk-2" });
    recordStageCheckpoint(deps(), stage);
    const output = backend.getStageOutput(WORKFLOW_ID, "rk-2");
    assert.deepEqual(output, { status: "completed", stageId: "stage-1" });
  });

  test("replay key generator namespaces by stage name + ordinal", () => {
    const gen = createStageReplayKeyGenerator(WORKFLOW_ID);
    const k1 = gen("analyze", "stage-1");
    const k2 = gen("analyze", "stage-2");
    assert.notEqual(k1, k2);
    assert.ok(k1.includes("analyze:1"));
    assert.ok(k2.includes("analyze:2"));
  });
});
