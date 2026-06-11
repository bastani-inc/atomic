import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageNotice, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

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

  test("does not clear a pending prompt stage through transient ask_user_question state", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("hil", { status: "running" })]));
    assert.equal(s.recordStagePendingPrompt("r1", "hil", {
      id: "prompt-1",
      kind: "select",
      message: "Choose one",
      choices: ["one", "two"],
      createdAt: 123,
    }), true);

    const versionBeforeClear = s.snapshot().version;
    assert.equal(s.recordStageAwaitingInput("r1", "hil", false), false);
    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "awaiting_input");
    assert.equal(stage.pendingPrompt?.id, "prompt-1");
    assert.equal(stage.awaitingInputSince, 123);
    assert.equal(s.snapshot().version, versionBeforeClear);
  });

  test("awaiting_input does not override paused or terminal stages", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [
      makeStage("paused", { status: "paused" }),
      makeStage("completed", { status: "completed" }),
      makeStage("failed", { status: "failed" }),
      makeStage("skipped", { status: "skipped" }),
    ]));

    assert.equal(s.recordStageAwaitingInput("r1", "paused", true), false);
    assert.equal(s.recordStageAwaitingInput("r1", "completed", true), false);
    assert.equal(s.recordStageAwaitingInput("r1", "failed", true), false);
    assert.equal(s.recordStageAwaitingInput("r1", "skipped", true), false);
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

  test("blocked and skipped stages cannot be paused", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a"), makeStage("skipped", { status: "skipped" })]));

    assert.equal(s.recordStageBlocked("r1", "a", "root"), true);
    assert.equal(s.recordStagePaused("r1", "a"), false);
    assert.equal(s.recordStagePaused("r1", "skipped"), false);
    assert.equal(s.snapshot().runs[0]!.stages[0]!.status, "blocked");
    assert.equal(s.snapshot().runs[0]!.stages[1]!.status, "skipped");
  });

  test("refuses terminal and paused stage blocked transitions", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [
      makeStage("completed", { status: "completed" }),
      makeStage("failed", { status: "failed" }),
      makeStage("skipped", { status: "skipped" }),
      makeStage("paused", { status: "paused" }),
    ]));

    assert.equal(s.recordStageBlocked("r1", "completed", "root"), false);
    assert.equal(s.recordStageBlocked("r1", "failed", "root"), false);
    assert.equal(s.recordStageBlocked("r1", "skipped", "root"), false);
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

  test("stage pause/resume tracks accumulated paused time", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a", { status: "running", startedAt: 1_000 })]));

    assert.equal(s.recordStagePaused("r1", "a", 6_000), true);
    assert.equal(s.recordStageResumed("r1", "a", 16_000), true);

    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.pausedAt, undefined);
    assert.equal(stage.resumedAt, 16_000);
    assert.equal(stage.pausedDurationMs, 10_000);
  });

  test("pending stage pause/resume does not subtract time before start", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [makeStage("a", { status: "pending" })]));

    assert.equal(s.recordStagePaused("r1", "a", 1_000), true);
    assert.equal(s.recordStageResumed("r1", "a", 6_000), true);

    const stage = s.snapshot().runs[0]!.stages[0]!;
    assert.equal(stage.status, "running");
    assert.equal(stage.pausedAt, undefined);
    assert.equal(stage.resumedAt, 6_000);
    assert.equal(stage.pausedDurationMs, undefined);
  });

  test("recordStageEnd clears workflow child metadata from non-completed terminal stages", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1", [
      makeStage("skipped-boundary", {
        status: "running",
        workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-run" },
        workflowChild: {
          alias: "child",
          workflow: "child-wf",
          runId: "child-run",
          status: "completed",
          outputs: { summary: "stale" },
        },
      }),
      makeStage("failed-boundary", {
        status: "running",
        workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-run" },
        workflowChild: {
          alias: "child",
          workflow: "child-wf",
          runId: "child-run",
          status: "completed",
          outputs: { summary: "stale" },
        },
      }),
    ]));

    s.recordStageEnd("r1", makeStage("skipped-boundary", {
      status: "skipped",
      endedAt: Date.now(),
      skippedReason: "workflow-exit",
      workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-run" },
      workflowChild: {
        alias: "child",
        workflow: "child-wf",
        runId: "child-run",
        status: "completed",
        outputs: { summary: "stale" },
      },
    }));
    s.recordStageEnd("r1", makeStage("failed-boundary", {
      status: "failed",
      endedAt: Date.now(),
      error: "boom",
      workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-run" },
      workflowChild: {
        alias: "child",
        workflow: "child-wf",
        runId: "child-run",
        status: "completed",
        outputs: { summary: "stale" },
      },
    }));

    const stages = s.snapshot().runs[0]!.stages;
    for (const stage of stages) {
      assert.equal(stage.workflowChildRun, undefined);
      assert.equal(stage.workflowChild, undefined);
    }
  });
});

describe("store run pausing", () => {
  test("run pause/resume tracks accumulated paused time", () => {
    const s = createStore();
    s.recordRunStart({ ...makeRun("r1"), startedAt: 1_000 });

    assert.equal(s.recordRunPaused("r1", 6_000), true);
    assert.equal(s.recordRunResumed("r1", 16_000), true);

    const run = s.snapshot().runs[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.pausedAt, undefined);
    assert.equal(run.resumedAt, 16_000);
    assert.equal(run.pausedDurationMs, 10_000);
  });

  test("recordRunEnd excludes paused time from final duration", () => {
    const originalNow = Date.now;
    try {
      const s = createStore();
      s.recordRunStart({ ...makeRun("r1"), startedAt: 1_000 });
      assert.equal(s.recordRunPaused("r1", 6_000), true);
      assert.equal(s.recordRunResumed("r1", 16_000), true);

      Date.now = () => 21_000;
      assert.equal(s.recordRunEnd("r1", "completed"), true);

      const run = s.snapshot().runs[0]!;
      assert.equal(run.durationMs, 10_000);
      assert.equal(run.pausedAt, undefined);
      assert.equal(run.pausedDurationMs, 10_000);
    } finally {
      Date.now = originalNow;
    }
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
