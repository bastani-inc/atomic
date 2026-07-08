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
