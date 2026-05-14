import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/shared/store.js";
import type { RunSnapshot, StageNotice, StageSnapshot } from "../../src/shared/store-types.js";

function makeStage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id,
    name: `stage-${id}`,
    status: "pending",
    parentIds: [],
    toolEvents: [],
    ...overrides,
  };
}

function makeRun(id: string, stages: StageSnapshot[] = []): RunSnapshot {
  return {
    id,
    name: `run-${id}`,
    inputs: {},
    status: "running",
    stages,
    startedAt: Date.now(),
  };
}

function makeNotice(id: string, overrides: Partial<StageNotice> = {}): StageNotice {
  return {
    id,
    ts: Date.now(),
    kind: "model",
    to: `target-${id}`,
    ...overrides,
  };
}

describe("store stage blocking", () => {
  test("transitions running → awaiting_input → running for in-stage HIL", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a", { status: "running" })]));

    assert.equal(s.recordStageAwaitingInput("r1", "a", true, 123), true);
    let stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "awaiting_input");
    assert.equal(stage.awaitingInputSince, 123);

    assert.equal(s.recordStageAwaitingInput("r1", "a", false), true);
    stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal("awaitingInputSince" in stage, false);
  });

  test("awaiting_input does not override paused or terminal stages", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [
      makeStage("paused", { status: "paused" }),
      makeStage("completed", { status: "completed" }),
      makeStage("failed", { status: "failed" }),
    ]));

    assert.equal(s.recordStageAwaitingInput("r1", "paused", true), false);
    assert.equal(s.recordStageAwaitingInput("r1", "completed", true), false);
    assert.equal(s.recordStageAwaitingInput("r1", "failed", true), false);
  });

  test("transitions pending → blocked → pending and snapshots only include blockedByStageId while set", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    assert.equal(s.recordStageBlocked("r1", "a", "root"), true);
    let stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "blocked");
    assert.equal(stage.blockedByStageId, "root");

    assert.equal(s.recordStageUnblocked("r1", "a"), true);
    stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "pending");
    assert.equal("blockedByStageId" in stage, false);
  });

  test("blocked stage cannot be paused again", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    assert.equal(s.recordStageBlocked("r1", "a", "root"), true);
    assert.equal(s.recordStagePaused("r1", "a"), false);
    assert.equal(s.snapshot().runs[0]!.stages[0]!.status, "blocked");
  });

  test("refuses terminal and paused stage blocked transitions", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [
      makeStage("completed", { status: "completed" }),
      makeStage("failed", { status: "failed" }),
      makeStage("paused", { status: "paused" }),
    ]));

    assert.equal(s.recordStageBlocked("r1", "completed", "root"), false);
    assert.equal(s.recordStageBlocked("r1", "failed", "root"), false);
    assert.equal(s.recordStageBlocked("r1", "paused", "root"), false);
  });

  test("blocking an already-blocked stage with the same blocker is a no-op", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    assert.equal(s.recordStageBlocked("r1", "a", "root"), true);
    const version = s.snapshot().version;
    assert.equal(s.recordStageBlocked("r1", "a", "root"), false);
    assert.equal(s.snapshot().version, version);
  });

  test("resume from blocked clears blockedByStageId and moves to running", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    assert.equal(s.recordStageBlocked("r1", "a", "root"), true);
    assert.equal(s.recordStageResumed("r1", "a", 123), true);
    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.resumedAt, 123);
    assert.equal("blockedByStageId" in stage, false);
  });

  test("recordStageResumed still resumes paused stages", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a", { status: "running" })]));

    assert.equal(s.recordStagePaused("r1", "a", 111), true);
    assert.equal(s.recordStageResumed("r1", "a", 222), true);
    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.pausedAt, undefined);
    assert.equal(stage.resumedAt, 222);
  });
});

describe("store stage notices", () => {
  test("recordStageNotice initialises notices and appends in order", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    const first = makeNotice("n1", { kind: "model", to: "claude-sonnet-4-5" });
    const second = makeNotice("n2", { kind: "thinking", from: "medium", to: "high" });
    assert.equal(s.recordStageNotice("r1", "a", first), true);
    assert.equal(s.recordStageNotice("r1", "a", second), true);

    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.deepEqual(stage.notices?.map((notice) => notice.id), ["n1", "n2"]);
    assert.equal(stage.notices?.[0]?.to, "claude-sonnet-4-5");
    assert.equal(stage.notices?.[1]?.from, "medium");
  });

  test("recordStageNotice returns false for unknown run or stage", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a")]));

    assert.equal(s.recordStageNotice("missing", "a", makeNotice("n1")), false);
    assert.equal(s.recordStageNotice("r1", "missing", makeNotice("n2")), false);
    assert.equal(s.snapshot().runs[0]!.stages[0]!.notices, undefined);
  });
});
