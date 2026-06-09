/**
 * Tests for the store's PendingPrompt API:
 *  - recordPendingPrompt accept/reject conditions
 *  - resolvePendingPrompt clears + fulfils the waiter
 *  - awaitPendingPrompt rejects when the run terminates first
 *  - clear() rejects every outstanding waiter
 *
 * These are the contract pieces the background UI adapter (and the graph
 * viewer overlay) depend on. If they regress, HIL routing through the store
 * either drops responses or leaks promises.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type {
  PendingPrompt,
  RunSnapshot,
  StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";

function makeRun(id: string): RunSnapshot {
  return {
    id,
    name: `run-${id}`,
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  };
}

function makePrompt(id: string, overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id,
    kind: "input",
    message: `prompt ${id}`,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeStage(id: string): StageSnapshot {
  return {
    id,
    name: `stage-${id}`,
    status: "running",
    parentIds: [],
    startedAt: Date.now(),
    toolEvents: [],
  };
}

function getRun(s: Store, runId: string): RunSnapshot {
  const run = s.runs().find((r) => r.id === runId);
  if (!run) throw new Error(`run ${runId} not found in store`);
  return run;
}

describe("store.recordPendingPrompt", () => {
  test("records the prompt on a running run", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    assert.equal(s.recordPendingPrompt("r1", makePrompt("p1")), true);
    const run = getRun(s, "r1");
    assert.equal(run.pendingPrompt?.id, "p1");
    assert.equal(run.pendingPrompt?.kind, "input");
  });

  test("returns false for an unknown runId", () => {
    const s = createStore();
    assert.equal(s.recordPendingPrompt("missing", makePrompt("p1")), false);
  });

  test("returns false when the run is already terminal", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordRunEnd("r1", "completed");
    assert.equal(s.recordPendingPrompt("r1", makePrompt("p1")), false);
  });

  test("returns false when a prompt is already pending", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    assert.equal(s.recordPendingPrompt("r1", makePrompt("p1")), true);
    assert.equal(s.recordPendingPrompt("r1", makePrompt("p2")), false);
  });

  test("notifies subscribers on success", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    let calls = 0;
    s.subscribe(() => {
      calls++;
    });
    s.recordPendingPrompt("r1", makePrompt("p1"));
    assert.equal(calls, 1);
  });

  test("does not notify subscribers on rejected calls", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordRunEnd("r1", "completed");
    let calls = 0;
    s.subscribe(() => {
      calls++;
    });
    s.recordPendingPrompt("r1", makePrompt("p1"));
    assert.equal(calls, 0);
  });
});

describe("store.recordStagePendingPrompt", () => {
  test("returns false for skipped terminal stages", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", { ...makeStage("s1"), status: "skipped", skippedReason: "fail-fast" });

    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), false);
    assert.equal(getRun(s, "r1").stages[0]?.pendingPrompt, undefined);
    assert.equal(getRun(s, "r1").stages[0]?.status, "skipped");
  });

  test("rejects a stage prompt waiter when that stage ends", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    const stage = makeStage("s1");
    s.recordStageStart("r1", stage);
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    const pending = s.awaitStagePendingPrompt("r1", "s1", "p1");

    s.recordStageEnd("r1", { ...stage, status: "failed", endedAt: Date.now(), error: "boom" });

    await assert.rejects(pending, /stage s1 ended before prompt resolved/);
    assert.equal(getRun(s, "r1").stages[0]?.pendingPrompt, undefined);
  });

  test("rejects a stage prompt waiter when the run ends", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    const pending = s.awaitStagePendingPrompt("r1", "s1", "p1");

    s.recordRunEnd("r1", "killed", undefined, "user abort");

    await assert.rejects(pending, /run r1 ended before prompt resolved/);
    assert.equal(getRun(s, "r1").stages[0]?.pendingPrompt, undefined);
  });

  test("resolved stage prompt answers stay in private ledger and out of snapshots", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1", { message: "Secret?" })), true);
    const waiter = s.awaitStagePendingPrompt("r1", "s1", "p1");
    assert.equal(s.resolveStagePendingPrompt("r1", "s1", "p1", "super-secret-value"), true);
    assert.equal(await waiter, "super-secret-value");

    const answer = s.getStagePromptAnswer("r1", "s1");
    assert.equal(answer?.value, "super-secret-value");
    assert.equal(answer?.kind, "input");
    assert.equal(JSON.stringify(s.snapshot()).includes("super-secret-value"), false);
    const stage = getRun(s, "r1").stages[0];
    assert.equal(stage?.promptAnswerState, "available");
    assert.equal(stage?.promptFootprint?.id, "p1");
    assert.equal(stage?.promptFootprint?.message, "Secret?");
    assert.equal(stage?.pendingPrompt, undefined);

    assert.equal(s.removeRun("r1"), true);
    assert.equal(s.getStagePromptAnswer("r1", "s1"), undefined);
  });

  test("records custom prompt answers without requiring stage.pendingPrompt", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", {
      ...makeStage("custom-stage"),
      status: "awaiting_input",
      awaitingInputSince: Date.now(),
    });
    const prompt = makePrompt("p-custom", {
      kind: "custom",
      message: "Pick a release channel",
      customIdentityHash: "identity-hash",
      customIdentitySource: "caller",
    });

    assert.equal(
      s.recordStagePromptAnswer("r1", "custom-stage", prompt, "private-custom-answer"),
      true,
    );

    const stage = getRun(s, "r1").stages[0]!;
    assert.equal(stage.pendingPrompt, undefined);
    assert.equal(stage.status, "running");
    assert.equal(stage.promptAnswerState, "available");
    assert.equal(stage.promptFootprint?.kind, "custom");
    assert.equal(stage.promptFootprint?.customIdentityHash, "identity-hash");
    assert.equal(s.getStagePromptAnswer("r1", "custom-stage")?.value, "private-custom-answer");
    assert.equal(JSON.stringify(s.snapshot()).includes("private-custom-answer"), false);
  });

  test("records independent prompts on multiple stages in the same run", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    s.recordStageStart("r1", makeStage("s2"));

    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    assert.equal(s.recordStagePendingPrompt("r1", "s2", makePrompt("p2")), true);

    const w1 = s.awaitStagePendingPrompt("r1", "s1", "p1");
    const w2 = s.awaitStagePendingPrompt("r1", "s2", "p2");

    assert.equal(s.resolveStagePendingPrompt("r1", "s1", "p1", "blue"), true);
    assert.equal(await w1, "blue");

    const run = getRun(s, "r1");
    assert.equal(run.stages[0]?.pendingPrompt, undefined);
    assert.equal(run.stages[1]?.pendingPrompt?.id, "p2");

    assert.equal(s.resolveStagePendingPrompt("r1", "s2", "p2", "green"), true);
    assert.equal(await w2, "green");
  });

  test("recordStageEnd preserves existing replay metadata when caller omits it", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", {
      ...makeStage("s1"),
      replayKey: "prompt:confirm:key",
      promptAnswerState: "available",
      replayedFromStageId: "source-stage",
      replayed: true,
    });

    s.recordStageEnd("r1", {
      ...makeStage("s1"),
      status: "completed",
      endedAt: Date.now(),
      durationMs: 1,
    });

    const stage = getRun(s, "r1").stages[0]!;
    assert.equal(stage.replayKey, "prompt:confirm:key");
    assert.equal(stage.promptAnswerState, "available");
    assert.equal(stage.replayedFromStageId, "source-stage");
    assert.equal(stage.replayed, true);
  });

  test("prompt answer ledger keys keep colon-bearing run and stage ids distinct", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("run:a"));
    s.recordRunStart(makeRun("run"));
    s.recordStageStart("run:a", makeStage("stage"));
    s.recordStageStart("run", makeStage("a:stage"));

    assert.equal(s.recordStagePendingPrompt("run:a", "stage", makePrompt("p1")), true);
    assert.equal(s.recordStagePendingPrompt("run", "a:stage", makePrompt("p2")), true);
    const w1 = s.awaitStagePendingPrompt("run:a", "stage", "p1");
    const w2 = s.awaitStagePendingPrompt("run", "a:stage", "p2");
    assert.equal(s.resolveStagePendingPrompt("run:a", "stage", "p1", "left"), true);
    assert.equal(s.resolveStagePendingPrompt("run", "a:stage", "p2", "right"), true);
    assert.equal(await w1, "left");
    assert.equal(await w2, "right");

    assert.equal(s.getStagePromptAnswer("run:a", "stage")?.value, "left");
    assert.equal(s.getStagePromptAnswer("run", "a:stage")?.value, "right");
  });

  test("removeRun purges prompt answer ledger entries for every stage in the run", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    s.recordStageStart("r1", makeStage("s2"));

    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    assert.equal(s.recordStagePendingPrompt("r1", "s2", makePrompt("p2")), true);
    const w1 = s.awaitStagePendingPrompt("r1", "s1", "p1");
    const w2 = s.awaitStagePendingPrompt("r1", "s2", "p2");

    assert.equal(s.resolveStagePendingPrompt("r1", "s1", "p1", "blue"), true);
    assert.equal(s.resolveStagePendingPrompt("r1", "s2", "p2", "green"), true);
    assert.equal(await w1, "blue");
    assert.equal(await w2, "green");
    assert.equal(s.getStagePromptAnswer("r1", "s1")?.value, "blue");
    assert.equal(s.getStagePromptAnswer("r1", "s2")?.value, "green");

    assert.equal(s.removeRun("r1"), true);
    assert.equal(s.getStagePromptAnswer("r1", "s1"), undefined);
    assert.equal(s.getStagePromptAnswer("r1", "s2"), undefined);
  });
});

describe("store.stagePromptDrafts", () => {
  test("records drafts for matching active input and editor prompts, including empty strings", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("input-stage"));
    s.recordStageStart("r1", makeStage("editor-stage"));
    assert.equal(s.recordStagePendingPrompt("r1", "input-stage", makePrompt("p-input")), true);
    assert.equal(s.recordStagePendingPrompt("r1", "editor-stage", makePrompt("p-editor", { kind: "editor" })), true);

    assert.equal(s.recordStagePromptDraft("r1", "input-stage", "p-input", ""), true);
    assert.equal(s.getStagePromptDraft("r1", "input-stage", "p-input"), "");
    assert.equal(s.recordStagePromptDraft("r1", "editor-stage", "p-editor", "draft text"), true);
    assert.equal(s.getStagePromptDraft("r1", "editor-stage", "p-editor"), "draft text");
  });

  test("keeps draft text out of snapshots", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    assert.equal(s.recordStagePromptDraft("r1", "s1", "p1", "super-secret-draft"), true);

    assert.equal(JSON.stringify(s.snapshot()).includes("super-secret-draft"), false);
  });

  test("rejects writes for unknown prompts and non-text prompt kinds", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    s.recordStageStart("r1", makeStage("s2"));
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p-confirm", { kind: "confirm" })), true);
    assert.equal(s.recordStagePendingPrompt("r1", "s2", makePrompt("p-select", { kind: "select", choices: ["a"] })), true);

    assert.equal(s.recordStagePromptDraft("missing", "s1", "p1", "x"), false);
    assert.equal(s.recordStagePromptDraft("r1", "missing", "p1", "x"), false);
    assert.equal(s.recordStagePromptDraft("r1", "s1", "wrong", "x"), false);
    assert.equal(s.recordStagePromptDraft("r1", "s1", "p-confirm", "x"), false);
    assert.equal(s.recordStagePromptDraft("r1", "s2", "p-select", "x"), false);
    assert.equal(s.getStagePromptDraft("r1", "s1", "p-confirm"), undefined);
  });

  test("draft ledger keys keep colon-bearing run, stage, and prompt ids distinct", () => {
    const s = createStore();
    s.recordRunStart(makeRun("run:a"));
    s.recordRunStart(makeRun("run"));
    s.recordStageStart("run:a", makeStage("stage"));
    s.recordStageStart("run", makeStage("a:stage"));
    assert.equal(s.recordStagePendingPrompt("run:a", "stage", makePrompt("p:1")), true);
    assert.equal(s.recordStagePendingPrompt("run", "a:stage", makePrompt("stage:p:1")), true);

    assert.equal(s.recordStagePromptDraft("run:a", "stage", "p:1", "left"), true);
    assert.equal(s.recordStagePromptDraft("run", "a:stage", "stage:p:1", "right"), true);

    assert.equal(s.getStagePromptDraft("run:a", "stage", "p:1"), "left");
    assert.equal(s.getStagePromptDraft("run", "a:stage", "stage:p:1"), "right");
  });

  test("clears drafts on prompt resolve", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordStageStart("r1", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("r1", "s1", makePrompt("p1")), true);
    const waiter = s.awaitStagePendingPrompt("r1", "s1", "p1");
    assert.equal(s.recordStagePromptDraft("r1", "s1", "p1", "draft"), true);
    assert.equal(s.resolveStagePendingPrompt("r1", "s1", "p1", "answer"), true);
    assert.equal(await waiter, "answer");
    assert.equal(s.getStagePromptDraft("r1", "s1", "p1"), undefined);
  });

  test("clears drafts on stage end, run end, removeRun, and clear", () => {
    const s = createStore();
    s.recordRunStart(makeRun("stage-end"));
    const endingStage = makeStage("s1");
    s.recordStageStart("stage-end", endingStage);
    assert.equal(s.recordStagePendingPrompt("stage-end", "s1", makePrompt("p-stage")), true);
    assert.equal(s.recordStagePromptDraft("stage-end", "s1", "p-stage", "stage draft"), true);
    s.recordStageEnd("stage-end", { ...endingStage, status: "failed", endedAt: Date.now(), error: "boom" });
    assert.equal(s.getStagePromptDraft("stage-end", "s1", "p-stage"), undefined);

    s.recordRunStart(makeRun("run-end"));
    s.recordStageStart("run-end", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("run-end", "s1", makePrompt("p-run")), true);
    assert.equal(s.recordStagePromptDraft("run-end", "s1", "p-run", "run draft"), true);
    s.recordRunEnd("run-end", "killed", undefined, "stop");
    assert.equal(s.getStagePromptDraft("run-end", "s1", "p-run"), undefined);

    s.recordRunStart(makeRun("remove"));
    s.recordStageStart("remove", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("remove", "s1", makePrompt("p-remove")), true);
    assert.equal(s.recordStagePromptDraft("remove", "s1", "p-remove", "remove draft"), true);
    assert.equal(s.removeRun("remove"), true);
    assert.equal(s.getStagePromptDraft("remove", "s1", "p-remove"), undefined);

    s.recordRunStart(makeRun("clear"));
    s.recordStageStart("clear", makeStage("s1"));
    assert.equal(s.recordStagePendingPrompt("clear", "s1", makePrompt("p-clear")), true);
    assert.equal(s.recordStagePromptDraft("clear", "s1", "p-clear", "clear draft"), true);
    s.clear();
    assert.equal(s.getStagePromptDraft("clear", "s1", "p-clear"), undefined);
  });
});

describe("store.resolvePendingPrompt", () => {
  test("clears the pending prompt and resolves the waiter", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordPendingPrompt("r1", makePrompt("p1"));
    const pending = s.awaitPendingPrompt("r1", "p1");
    assert.equal(s.resolvePendingPrompt("r1", "p1", "answer"), true);
    const response = await pending;
    assert.equal(response, "answer");
    assert.equal(getRun(s, "r1").pendingPrompt, undefined);
  });

  test("returns false when promptId mismatches", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordPendingPrompt("r1", makePrompt("p1"));
    assert.equal(s.resolvePendingPrompt("r1", "wrong-id", "answer"), false);
    // pending prompt still set, no waiter fired
    assert.equal(getRun(s, "r1").pendingPrompt?.id, "p1");
  });

  test("returns false when the run has no pending prompt", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    assert.equal(s.resolvePendingPrompt("r1", "p1", "answer"), false);
  });

  test("returns false for unknown runId", () => {
    const s = createStore();
    assert.equal(s.resolvePendingPrompt("missing", "p1", "answer"), false);
  });

  test("forwards arbitrary response shapes (boolean, object)", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordPendingPrompt("r1", makePrompt("p1", { kind: "confirm" }));
    const pending = s.awaitPendingPrompt("r1", "p1");
    s.resolvePendingPrompt("r1", "p1", true);
    assert.equal(await pending, true);
  });
});

describe("store.awaitPendingPrompt", () => {
  test("rejects when run terminates before resolve", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordPendingPrompt("r1", makePrompt("p1"));
    const pending = s.awaitPendingPrompt("r1", "p1");
    s.recordRunEnd("r1", "killed", undefined, "user abort");
    await assert.rejects(pending, /run r1 ended before prompt resolved/);
  });

  test("rejects synchronously when run is unknown", async () => {
    const s = createStore();
    await assert.rejects(s.awaitPendingPrompt("missing", "p1"));
  });

  test("rejects synchronously when prompt id mismatches", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordPendingPrompt("r1", makePrompt("p1"));
    await assert.rejects(s.awaitPendingPrompt("r1", "p2"));
  });
});

describe("store.clear", () => {
  test("rejects every outstanding pending waiter", async () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordRunStart(makeRun("r2"));
    s.recordPendingPrompt("r1", makePrompt("p1"));
    s.recordPendingPrompt("r2", makePrompt("p2"));
    const w1 = s.awaitPendingPrompt("r1", "p1");
    const w2 = s.awaitPendingPrompt("r2", "p2");
    s.clear();
    await assert.rejects(w1, /store cleared/);
    await assert.rejects(w2, /store cleared/);
  });
});
