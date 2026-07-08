import { test } from "bun:test";
import assert from "node:assert/strict";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

function makeSessionManager(entries: readonly SessionEntry[]) {
  return { getEntries: () => entries };
}

test("restoreOnSessionStart restores terminal run end time and duration", () => {
  const store = createStore();
  const entries: SessionEntry[] = [
    { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
    { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
    { id: "e3", type: "workflow.stage.end", payload: { runId: "r1", stageId: "s1", status: "completed", summary: "done" } },
    { id: "e4", type: "workflow.run.end", payload: { runId: "r1", status: "completed", endedAt: 5000, durationMs: 4999, ts: 5000 } },
  ];

  restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, store);
  const run = store.runs()[0];
  assert.notEqual(run, undefined);
  assert.equal(run.status, "completed");
  assert.equal(run.endedAt, 5000);
  assert.equal(run.durationMs, 4999);
  assert.equal(run.stages[0]?.status, "completed");
});

test("restoreOnSessionStart reads real Atomic custom workflow entries for in-flight runs", () => {
  const store = createStore();
  const entries: SessionEntry[] = [
    { id: "c1", type: "custom", customType: "workflow.run.start", data: { runId: "r-custom-live", name: "wf", inputs: {}, ts: 10 } },
    { id: "c2", type: "custom", customType: "workflow.stage.start", data: { runId: "r-custom-live", stageId: "s1", name: "review", parentIds: [], ts: 11 } },
  ];

  restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, store);
  const run = store.runs()[0];
  assert.equal(run?.id, "r-custom-live");
  assert.equal(run?.status, "failed");
  assert.equal(run?.stages[0]?.name, "review");
  assert.equal(run?.stages[0]?.status, "failed");
});

test("restoreOnSessionStart reads real Atomic custom workflow entries for terminal runs", () => {
  const store = createStore();
  const entries: SessionEntry[] = [
    { id: "c1", type: "custom", customType: "workflow.run.start", data: { runId: "r-custom-terminal", name: "wf", inputs: {}, ts: 10 } },
    { id: "c2", type: "custom", customType: "workflow.stage.start", data: { runId: "r-custom-terminal", stageId: "s1", name: "review", parentIds: [], ts: 11 } },
    { id: "c3", type: "custom", customType: "workflow.stage.end", data: { runId: "r-custom-terminal", stageId: "s1", status: "completed", summary: "done", durationMs: 5 } },
    { id: "c4", type: "custom", customType: "workflow.run.end", data: { runId: "r-custom-terminal", status: "completed", result: { ok: true }, endedAt: 20, durationMs: 10, ts: 20 } },
  ];

  restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, store);
  const run = store.runs()[0];
  assert.equal(run?.id, "r-custom-terminal");
  assert.equal(run?.status, "completed");
  assert.equal(run?.endedAt, 20);
  assert.equal(run?.durationMs, 10);
  assert.equal(run?.stages[0]?.status, "completed");
  assert.equal(run?.stages[0]?.result, "done");
});
