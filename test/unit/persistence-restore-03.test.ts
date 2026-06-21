// @ts-nocheck
/**
 * Unit tests for shared/persistence-restore.ts
 * cross-ref: spec §5.6, §5.13
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { scanInFlightRuns, restoreOnSessionStart } from "../../packages/workflows/src/shared/persistence-restore.js";
import type { SessionEntry, InFlightRun } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

// ---------------------------------------------------------------------------
// scanInFlightRuns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// restoreOnSessionStart
// ---------------------------------------------------------------------------
describe("restoreOnSessionStart", () => {
  function makeSessionManager(entries: SessionEntry[]) {
    return { getEntries: () => entries };
  }

  test("restores workflow.run.blocked only onto descendants of the failed stage", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "failed", parentIds: [], ts: 2 } },
      {
        id: "e3",
        type: "workflow.stage.end",
        payload: {
          runId: "r1",
          stageId: "s1",
          status: "failed",
          error: "rate limit",
          failureKind: "rate_limit",
          failureCode: "rate_limited",
          failureRecoverability: "recoverable",
          failureDisposition: "active_blocked",
          failureMessage: "HTTP 429",
        },
      },
      { id: "e4", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s2", name: "unrelated", parentIds: [], ts: 3 } },
      { id: "e5", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s3", name: "direct", parentIds: ["s1"], ts: 4 } },
      { id: "e6", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s4", name: "transitive", parentIds: ["s3"], ts: 5 } },
      {
        id: "e7",
        type: "workflow.run.blocked",
        payload: {
          runId: "r1",
          failedStageId: "s1",
          error: "rate limit",
          failureKind: "rate_limit",
          failureCode: "rate_limited",
          failureMessage: "HTTP 429",
          failureRecoverability: "recoverable",
          failureDisposition: "active_blocked",
          resumable: true,
          ts: 6,
        },
      },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);

    const run = st.runs()[0]!;
    const byId = new Map(run.stages.map((stage) => [stage.id, stage]));
    const s1 = byId.get("s1")!;
    const s2 = byId.get("s2")!;
    const s3 = byId.get("s3")!;
    const s4 = byId.get("s4")!;

    assert.equal(run.status, "running");
    assert.equal(s1.status, "failed");
    assert.equal(s2.status, "running");
    assert.equal(s2.blockedByStageId, undefined);
    assert.equal(s3.status, "blocked");
    assert.equal(s3.blockedByStageId, "s1");
    assert.equal(s4.status, "blocked");
    assert.equal(s4.blockedByStageId, "s1");
  });
});
