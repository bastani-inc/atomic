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
describe("scanInFlightRuns", () => {
  test("returns empty for empty entries", () => {
    assert.equal(scanInFlightRuns([]).length, 0);
  });

  test("returns empty when all runs have ended", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end", payload: { runId: "r1", status: "completed", ts: 2 } },
    ];
    assert.equal(scanInFlightRuns(entries).length, 0);
  });

  test("returns in-flight run when run.start has no run.end", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 100 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.runId, "r1");
    assert.equal(result[0]!.name, "wf");
    assert.equal(result[0]!.startTs, 100);
  });

  test("handles multiple runs: only unended ones returned", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf1", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end",   payload: { runId: "r1", status: "completed", ts: 2 } },
      { id: "e3", type: "workflow.run.start", payload: { runId: "r2", name: "wf2", inputs: {}, ts: 3 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.runId, "r2");
  });

  test("collects stageIds from stage.start entries for in-flight run", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start",   payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s2", name: "analyze", parentIds: ["s1"], ts: 3 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.deepEqual(result[0]!.stageIds, ["s1", "s2"]);
  });

  test("does not duplicate stageIds from duplicate stage.start entries", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start",  payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 2 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.deepEqual(result[0]!.stageIds, ["s1"]);
  });

  test("preserves inputs from run.start payload", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: { key: "val" }, ts: 1 } },
    ];
    const result = scanInFlightRuns(entries);
    assert.equal((result[0]!.inputs as Record<string, unknown>)["key"], "val");
  });

  test("handles missing/malformed run.start payload gracefully", () => {
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: {} }, // missing runId/name/ts
    ];
    // Should not throw, and should return empty (invalid entry skipped)
    const result = scanInFlightRuns(entries);
    assert.equal(result.length, 0);
  });
});
