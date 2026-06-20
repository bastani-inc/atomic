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

  test("no-op when persistRuns=false", () => {
    const st = createStore();
    const crashed: InFlightRun[] = [];
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      ]),
      { resumeInFlight: "never", persistRuns: false },
      st,
      { onCrashed: (r) => crashed.push(r) },
    );
    assert.equal(st.runs().length, 0);
    assert.equal(crashed.length, 0);
  });
  test("no-op when sessionManager.getEntries absent", () => {
    const st = createStore();
    restoreOnSessionStart(
      {}, // no getEntries
      { resumeInFlight: "never", persistRuns: true },
      st,
    );
    assert.equal(st.runs().length, 0);
  });
  test("no-op when no in-flight runs found", () => {
    const st = createStore();
    const crashed: InFlightRun[] = [];
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
        { id: "e2", type: "workflow.run.end",   payload: { runId: "r1", status: "completed", ts: 2 } },
      ]),
      { resumeInFlight: "never", persistRuns: true },
      st,
      { onCrashed: (r) => crashed.push(r) },
    );
    assert.equal(crashed.length, 0);
    assert.equal(st.runs().length, 1);
    assert.equal(st.runs()[0]?.status, "completed");
  });
  test("resumeInFlight=never: marks run as failed and calls onCrashed", () => {
    const st = createStore();
    const crashed: InFlightRun[] = [];
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "my-wf", inputs: {}, ts: 1 } },
      ]),
      { resumeInFlight: "never", persistRuns: true },
      st,
      { onCrashed: (r) => crashed.push(r) },
    );
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0]!.runId, "r1");
    const runs = st.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
  });
  test("resumeInFlight=ask: same behavior as never for store/callback", () => {
    const st = createStore();
    const crashed: InFlightRun[] = [];
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      ]),
      { resumeInFlight: "ask", persistRuns: true },
      st,
      { onCrashed: (r) => crashed.push(r) },
    );
    assert.equal(crashed.length, 1);
    assert.equal(st.runs()[0]!.status, "failed");
  });
  test("resumeInFlight=auto: marks run as running and calls onResume", () => {
    const st = createStore();
    const resumed: InFlightRun[] = [];
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      ]),
      { resumeInFlight: "auto", persistRuns: true },
      st,
      { onResume: (r) => resumed.push(r) },
    );
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.runId, "r1");
    // Store run should be "running" (auto resume)
    const runs = st.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "running");
  });
  test("crashed run has endedAt set (marked ended)", () => {
    const st = createStore();
    restoreOnSessionStart(
      makeSessionManager([
        { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      ]),
      { resumeInFlight: "never", persistRuns: true },
      st,
    );
    const run = st.runs()[0]!;
    assert.notEqual(run.endedAt, undefined);
  });
  test("stage session metadata is restored from stage.end entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "review", parentIds: [], ts: 2 } },
      {
        id: "e3",
        type: "workflow.stage.end",
        payload: {
          runId: "r1",
          stageId: "s1",
          status: "failed",
          sessionId: "session-1",
          sessionFile: "/tmp/session-1.jsonl",
        },
      },
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const stage = st.runs()[0]?.stages[0];
    assert.equal(stage?.sessionId, "session-1");
    assert.equal(stage?.sessionFile, "/tmp/session-1.jsonl");
  });
  test("stage snapshots are rebuilt from session entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start",   payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.end",    payload: { runId: "r1", stageId: "s1", status: "completed", durationMs: 100 } },
      { id: "e4", type: "workflow.stage.start",  payload: { runId: "r1", stageId: "s2", name: "analyze", parentIds: ["s1"], ts: 3 } },
      // s2 never got a stage.end entry — crashed
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.stages.length, 2);
    const s1 = run.stages.find((s) => s.id === "s1");
    const s2 = run.stages.find((s) => s.id === "s2");
    assert.equal(s1!.status, "completed");
    assert.equal(s2!.status, "failed");
    assert.notEqual(s2!.error, undefined);
  });
  test("restores continuation and replay metadata", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r2", name: "wf", inputs: {}, resumedFromRunId: "r1", resumeFromStageId: "old-failed", ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r2", stageId: "s-new", name: "first", parentIds: [], replayKey: "prompt:confirm:abc:1", replayedFromStageId: "s-old", replayed: true, ts: 2 } },
      { id: "e3", type: "workflow.stage.end", payload: { runId: "r2", stageId: "s-new", status: "completed", summary: "old result", replayKey: "prompt:confirm:abc:1", replayedFromStageId: "s-old", replayed: true } },
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.resumedFromRunId, "r1");
    assert.equal(run.resumeFromStageId, "old-failed");
    const stage = run.stages[0]!;
    assert.equal(stage.result, "old result");
    assert.equal(stage.replayKey, "prompt:confirm:abc:1");
    assert.equal(stage.replayedFromStageId, "s-old");
    assert.equal(stage.replayed, true);
  });
  test("restores workflow child replay metadata from stage.end", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r2", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r2", stageId: "s-new", name: "import:child", parentIds: [], replayKey: "workflow:import:child", ts: 2 } },
      {
        id: "e3",
        type: "workflow.stage.end",
        payload: {
          runId: "r2",
          stageId: "s-new",
          status: "completed",
          summary: "child done",
          workflowChild: {
            alias: "child",
            workflow: "child-wf",
            runId: "child-run",
            status: "completed",
            exited: true,
            outputs: { summary: "ok" },
          },
        },
      },
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const stage = st.runs()[0]!.stages[0]!;
    assert.equal(stage.workflowChild?.alias, "child");
    assert.equal(stage.workflowChild?.workflow, "child-wf");
    assert.equal(stage.workflowChild?.runId, "child-run");
    assert.equal(stage.workflowChild?.status, "completed");
    assert.equal(stage.workflowChild?.exited, true);
    assert.deepEqual(stage.workflowChild?.outputs, { summary: "ok" });
  });
  test("ignores workflow child replay metadata from skipped and failed stage.end entries", () => {
    for (const status of ["skipped", "failed"] as const) {
      const st = createStore();
      const entries: SessionEntry[] = [
        { id: `${status}-e1`, type: "workflow.run.start", payload: { runId: `r-${status}`, name: "wf", inputs: {}, ts: 1 } },
        { id: `${status}-e2`, type: "workflow.stage.start", payload: { runId: `r-${status}`, stageId: "boundary", name: "import:child", parentIds: [], replayKey: "workflow:import:child", ts: 2 } },
        {
          id: `${status}-e3`,
          type: "workflow.stage.end",
          payload: {
            runId: `r-${status}`,
            stageId: "boundary",
            status,
            ...(status === "skipped" ? { skippedReason: "workflow-exit" } : { error: "boom" }),
            workflowChild: {
              alias: "child",
              workflow: "child-wf",
              runId: "child-run",
              status: "completed",
              outputs: { summary: "stale" },
            },
          },
        },
        { id: `${status}-e4`, type: "workflow.run.end", payload: { runId: `r-${status}`, status, ts: 3 } },
      ];
      restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
      const stage = st.runs()[0]!.stages[0]!;
      assert.equal(stage.status, status);
      assert.equal(stage.workflowChild, undefined);
    }
  });
  test("restores malformed and non-terminal stage.end statuses as failed", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "one", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.end", payload: { runId: "r1", stageId: "s1", status: "running" } },
      { id: "e4", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s2", name: "two", parentIds: [], ts: 3 } },
      { id: "e5", type: "workflow.stage.end", payload: { runId: "r1", stageId: "s2", status: "nonsense" } },
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    assert.equal(st.runs()[0]!.stages[0]!.status, "failed");
    assert.equal(st.runs()[0]!.stages[1]!.status, "failed");
  });
  test("restores failed terminal run metadata from run.end entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.end", payload: { runId: "r1", stageId: "s1", status: "failed", error: "rate limit", failureKind: "rate_limit" } },
      {
        id: "e4",
        type: "workflow.run.end",
        payload: {
          runId: "r1",
          status: "failed",
          error: "rate limit",
          failureKind: "rate_limit",
          failureCode: "rate_limited",
          failureRecoverability: "recoverable",
          failureDisposition: "terminal_failed",
          failureMessage: "429 too many requests",
          failedStageId: "s1",
          resumable: true,
          retryAfterMs: 2000,
          ts: 3,
        },
      },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.error, "rate limit");
    assert.equal(run.failureKind, "rate_limit");
    assert.equal(run.failureCode, "rate_limited");
    assert.equal(run.failureRecoverability, "recoverable");
    assert.equal(run.failureDisposition, "terminal_failed");
    assert.equal(run.failureMessage, "429 too many requests");
    assert.equal(run.failedStageId, "s1");
    assert.equal(run.resumable, true);
    assert.equal(run.retryAfterMs, 2000);
  });
  test("restores completed terminal runs from run.end entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.stage.end", payload: { runId: "r1", stageId: "s1", status: "completed", summary: "done" } },
      { id: "e4", type: "workflow.run.end", payload: { runId: "r1", status: "completed", ts: 3 } },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.status, "completed");
    assert.notEqual(run.endedAt, undefined);
    assert.equal(run.stages[0]!.status, "completed");
  });
  test("restores completed ctx.exit markers from run.end entries without requiring completed stages", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r-exit", name: "wf", inputs: {}, ts: 1 } },
      {
        id: "e2",
        type: "workflow.run.end",
        payload: {
          runId: "r-exit",
          status: "completed",
          exited: true,
          exitReason: "guard",
          result: { note: "ok" },
          resumable: false,
          ts: 2,
        },
      },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.status, "completed");
    assert.equal(run.exited, true);
    assert.equal(run.exitReason, "guard");
    assert.equal(run.resumable, false);
    assert.deepEqual(run.result, { note: "ok" });
    assert.deepEqual(run.stages, []);
  });
  test("skips completed terminal runs with incomplete stage end data", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      { id: "e3", type: "workflow.run.end", payload: { runId: "r1", status: "completed", ts: 3 } },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);

    assert.deepEqual(st.runs(), []);
  });
  test("ignores invalid run failureKind from run.end entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.run.end", payload: { runId: "r1", status: "failed", error: "boom", failureKind: "not-real", resumable: true, ts: 2 } },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const run = st.runs()[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, undefined);
    assert.equal(run.resumable, true);
  });
  test("restores stage failure metadata from stage.end entries", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
      {
        id: "e3",
        type: "workflow.stage.end",
        payload: {
          runId: "r1",
          stageId: "s1",
          status: "failed",
          error: "You must be logged in to run workflows. Run /login and try again.",
          failureKind: "auth",
          failureCode: "missing_api_key",
          failureRecoverability: "recoverable",
          failureDisposition: "active_blocked",
          failureMessage: "No API key found",
          retryAfterMs: 1000,
          durationMs: 100,
        },
      },
    ];
    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);
    const stage = st.runs()[0]!.stages[0]!;
    assert.equal(stage.status, "failed");
    assert.equal(stage.error, "You must be logged in to run workflows. Run /login and try again.");
    assert.equal(stage.failureKind, "auth");
    assert.equal(stage.failureCode, "missing_api_key");
    assert.equal(stage.failureRecoverability, "recoverable");
    assert.equal(stage.failureDisposition, "active_blocked");
    assert.equal(stage.failureMessage, "No API key found");
    assert.equal(stage.retryAfterMs, 1000);
  });
  test("restores workflow.run.blocked as active recoverable state for any resumeInFlight policy", () => {
    const st = createStore();
    const entries: SessionEntry[] = [
      { id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
      { id: "e2", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s1", name: "fetch", parentIds: [], ts: 2 } },
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
          retryAfterMs: 5000,
        },
      },
      { id: "e4", type: "workflow.stage.start", payload: { runId: "r1", stageId: "s2", name: "after", parentIds: ["s1"], ts: 3 } },
      {
        id: "e5",
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
          retryAfterMs: 5000,
          resumable: true,
          ts: 4,
        },
      },
    ];

    restoreOnSessionStart(makeSessionManager(entries), { resumeInFlight: "never", persistRuns: true }, st);

    const run = st.runs()[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.endedAt, undefined);
    assert.equal(run.error, "rate limit");
    assert.equal(run.failureKind, "rate_limit");
    assert.equal(run.failureCode, "rate_limited");
    assert.equal(run.failureRecoverability, "recoverable");
    assert.equal(run.failureDisposition, "active_blocked");
    assert.equal(run.failureMessage, "HTTP 429");
    assert.equal(run.failedStageId, "s1");
    assert.equal(run.resumable, true);
    assert.equal(run.retryAfterMs, 5000);
    assert.equal(run.blockedAt, 4);
    assert.equal(run.stages[0]!.status, "failed");
    assert.equal(run.stages[1]!.status, "blocked");
    assert.equal(run.stages[1]!.blockedByStageId, "s1");
  });
});
