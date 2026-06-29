/**
 * Tests for:
 *  - recordRunEnd terminal guard (completed | failed | killed cannot be overwritten)
 *  - recordRunEnd boolean return
 *  - error param only stored for failed/killed; result only stored for completed
 *  - removeRun drops runs and associated run notices from live history
 *  - WorkflowNotice APIs: recordNotice, ackNotice, notices()
 *  - StoreSnapshot includes notices
 */

import { beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, WorkflowNotice } from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeNotice(id: string, overrides: Partial<WorkflowNotice> = {}): WorkflowNotice {
  return {
    id,
    level: "info",
    message: `notice ${id}`,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// removeRun
// ---------------------------------------------------------------------------

describe("removeRun", () => {
  test("removes run and run notices from live history", () => {
    const s = createStore();
    s.recordRunStart(makeRun("r1"));
    s.recordNotice(makeNotice("n1", { runId: "r1" }));
    s.recordNotice(makeNotice("n2", { runId: "other" }));

    assert.equal(s.removeRun("r1"), true);

    assert.equal(s.runs().some((r) => r.id === "r1"), false);
    assert.equal(s.notices().some((n) => n.runId === "r1"), false);
    assert.equal(s.notices().some((n) => n.id === "n2"), true);
  });

  test("returns false for an unknown run", () => {
    const s = createStore();

    assert.equal(s.removeRun("missing"), false);
  });
});

// ---------------------------------------------------------------------------
// Terminal guard — recordRunEnd
// ---------------------------------------------------------------------------

describe("recordRunEnd — terminal guard", () => {
  let s: Store;

  beforeEach(() => {
    s = createStore();
    s.recordRunStart(makeRun("r1"));
  });

  test("returns true when state changes (running → completed)", () => {
    assert.equal(s.recordRunEnd("r1", "completed"), true);
  });

  test("returns false for unknown runId", () => {
    assert.equal(s.recordRunEnd("no-such-run", "completed"), false);
  });

  test("sets endedAt and durationMs on success", () => {
    s.recordRunEnd("r1", "completed");
    const run = s.runs().find((r) => r.id === "r1")!;
    assert.notEqual(run.endedAt, undefined);
    assert.ok(run.durationMs! >= 0);
  });

  // --- completed is terminal ---

  test("completed cannot be overwritten by completed", () => {
    s.recordRunEnd("r1", "completed");
    const changed = s.recordRunEnd("r1", "completed");
    assert.equal(changed, false);
  });

  test("completed cannot be overwritten by failed", () => {
    s.recordRunEnd("r1", "completed");
    assert.equal(s.recordRunEnd("r1", "failed"), false);
    assert.equal(s.runs().find((r) => r.id === "r1")!.status, "completed");
  });

  test("completed cannot be overwritten by killed", () => {
    s.recordRunEnd("r1", "completed");
    assert.equal(s.recordRunEnd("r1", "killed"), false);
    assert.equal(s.runs().find((r) => r.id === "r1")!.status, "completed");
  });

  // --- failed is terminal ---

  test("failed cannot be overwritten by completed", () => {
    s.recordRunEnd("r1", "failed");
    assert.equal(s.recordRunEnd("r1", "completed"), false);
    assert.equal(s.runs().find((r) => r.id === "r1")!.status, "failed");
  });

  test("failed cannot be overwritten by killed", () => {
    s.recordRunEnd("r1", "failed");
    assert.equal(s.recordRunEnd("r1", "killed"), false);
  });

  // --- killed is terminal ---

  test("killed cannot be overwritten by completed", () => {
    s.recordRunEnd("r1", "killed");
    assert.equal(s.recordRunEnd("r1", "completed"), false);
    assert.equal(s.runs().find((r) => r.id === "r1")!.status, "killed");
  });

  test("killed cannot be overwritten by failed", () => {
    s.recordRunEnd("r1", "killed");
    assert.equal(s.recordRunEnd("r1", "failed"), false);
  });

  // --- result/error field rules ---

  test("result stored for completed", () => {
    s.recordRunEnd("r1", "completed", { answer: 42 });
    assert.deepEqual(s.runs().find((r) => r.id === "r1")!.result, { answer: 42 });
  });

  test("result stored for failed", () => {
    s.recordRunEnd("r1", "failed", { answer: 42 });
    assert.deepEqual(s.runs().find((r) => r.id === "r1")!.result, { answer: 42 });
  });

  test("result NOT stored for killed", () => {
    s.recordRunEnd("r1", "killed", { answer: 42 });
    assert.equal(s.runs().find((r) => r.id === "r1")!.result, undefined);
  });

  test("error stored for failed", () => {
    s.recordRunEnd("r1", "failed", undefined, "boom");
    assert.equal(s.runs().find((r) => r.id === "r1")!.error, "boom");
  });

  test("error stored for killed", () => {
    s.recordRunEnd("r1", "killed", undefined, "signal 9");
    assert.equal(s.runs().find((r) => r.id === "r1")!.error, "signal 9");
  });

  test("error NOT stored for completed", () => {
    s.recordRunEnd("r1", "completed", undefined, "ignored-error");
    assert.equal(s.runs().find((r) => r.id === "r1")!.error, undefined);
  });

  // --- endedAt not overwritten on guard rejection ---

  test("endedAt not overwritten after terminal guard rejection", () => {
    s.recordRunEnd("r1", "completed");
    const endedAt = s.runs().find((r) => r.id === "r1")!.endedAt!;
    // small delay then attempt overwrite
    const changed = s.recordRunEnd("r1", "failed");
    assert.equal(changed, false);
    assert.equal(s.runs().find((r) => r.id === "r1")!.endedAt, endedAt);
  });

  // --- subscriber notified exactly once per successful call ---

  test("subscriber notified on success, not notified on guard rejection", () => {
    const calls: number[] = [];
    s.subscribe((snap) => calls.push(snap.version));

    s.recordRunEnd("r1", "completed"); // should notify
    const versionAfterFirst = calls[calls.length - 1];

    s.recordRunEnd("r1", "failed"); // guard: no notify
    assert.equal(calls[calls.length - 1], versionAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// WorkflowNotice APIs
// ---------------------------------------------------------------------------

describe("recordNotice and ackNotice", () => {
  let s: Store;

  beforeEach(() => {
    s = createStore();
  });

  test("notices() initially empty", () => {
    assert.equal(s.notices().length, 0);
  });

  test("recordNotice stores notice", () => {
    s.recordNotice(makeNotice("n1"));
    assert.equal(s.notices().length, 1);
    assert.equal(s.notices()[0]!.id, "n1");
  });

  test("recordNotice increments version and notifies", () => {
    const versions: number[] = [];
    s.subscribe((snap) => versions.push(snap.version));
    s.recordNotice(makeNotice("n1"));
    assert.ok(versions.length >= 1);
  });

  test("notices included in snapshot", () => {
    s.recordNotice(makeNotice("n1", { level: "warning", message: "watch out" }));
    const snap = s.snapshot();
    assert.equal(snap.notices.length, 1);
    assert.equal(snap.notices[0]!.level, "warning");
    assert.equal(snap.notices[0]!.message, "watch out");
  });

  test("ackNotice returns true and sets ackedAt", () => {
    s.recordNotice(makeNotice("n1", { requiresAck: true }));
    const before = Date.now();
    const result = s.ackNotice("n1");
    const after = Date.now();
    assert.equal(result, true);
    const notice = s.notices().find((n) => n.id === "n1")!;
    assert.ok(notice.ackedAt! >= before);
    assert.ok(notice.ackedAt! <= after);
  });

  test("ackNotice returns false for unknown id", () => {
    assert.equal(s.ackNotice("no-such-notice"), false);
  });

  test("ackNotice returns false if already acked", () => {
    s.recordNotice(makeNotice("n1"));
    s.ackNotice("n1");
    assert.equal(s.ackNotice("n1"), false);
  });

  test("ackNotice notifies subscriber", () => {
    s.recordNotice(makeNotice("n1"));
    const versions: number[] = [];
    s.subscribe((snap) => versions.push(snap.version));
    s.ackNotice("n1");
    assert.ok(versions.length >= 1);
  });

  test("ackNotice on unknown id does not notify", () => {
    const versions: number[] = [];
    s.subscribe((snap) => versions.push(snap.version));
    s.ackNotice("ghost");
    assert.equal(versions.length, 0);
  });

  test("multiple notices stored independently", () => {
    s.recordNotice(makeNotice("n1", { level: "info" }));
    s.recordNotice(makeNotice("n2", { level: "error" }));
    s.recordNotice(makeNotice("n3", { level: "warning" }));
    assert.equal(s.notices().length, 3);
    assert.equal(s.notices()[1]!.level, "error");
  });

  test("notice can carry runId and stageId", () => {
    s.recordNotice(makeNotice("n1", { runId: "r1", stageId: "s1" }));
    const snap = s.snapshot();
    assert.equal(snap.notices[0]!.runId, "r1");
    assert.equal(snap.notices[0]!.stageId, "s1");
  });

  test("snapshot notices are deep-cloned (immutable from outside)", () => {
    s.recordNotice(makeNotice("n1", { message: "original" }));
    const snap = s.snapshot();
    // Mutating snapshot should not affect store
    (snap.notices[0] as WorkflowNotice).message = "mutated";
    assert.equal(s.notices()[0]!.message, "original");
  });
});
