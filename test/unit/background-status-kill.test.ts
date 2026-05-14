/**
 * Focused tests for killRun / killAllRuns kill-controls persistence wiring,
 * and resumeRun snapshot retrieval.
 * cross-ref: spec §8.1 Phase D — persist-kill-controls, resume-helper
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { killRun, killAllRuns, resumeRun } from "../../src/runs/background/status.js";
import { createStore } from "../../src/shared/store.js";
import { createCancellationRegistry } from "../../src/runs/background/cancellation-registry.js";
import type { WorkflowPersistencePort } from "../../src/shared/types.js";
import type { RunSnapshot, StageSnapshot } from "../../src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Pick<RunSnapshot, "id" | "name" | "status">> = {}): RunSnapshot {
  return {
    id: overrides.id ?? "run-1",
    name: overrides.name ?? "test-run",
    inputs: {},
    status: overrides.status ?? "running",
    stages: [],
    startedAt: Date.now(),
  };
}

function makePersistence(): { port: WorkflowPersistencePort; calls: Array<{ type: string; payload: Record<string, unknown> }> } {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const port: WorkflowPersistencePort = {
    appendEntry(type, payload) {
      calls.push({ type, payload });
      return `entry-${calls.length}`;
    },
  };
  return { port, calls };
}

// ---------------------------------------------------------------------------
// killRun — no persistence port
// ---------------------------------------------------------------------------

describe("killRun — no persistence", () => {
  test("returns ok:false not_found for unknown runId", () => {
    const s = createStore();
    const result = killRun("unknown", { store: s });
    assert.deepEqual(result, { ok: false, runId: "unknown", reason: "not_found" });
  });

  test("returns ok:false already_ended for ended run", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");
    const result = killRun(run.id, { store: s });
    assert.deepEqual(result, { ok: false, runId: run.id, reason: "already_ended" });
  });

  test("kills in-flight run, returns ok:true with previousStatus", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    const result = killRun(run.id, { store: s });
    assert.deepEqual(result, { ok: true, runId: run.id, previousStatus: "running" });
    const stored = s.runs().find((r) => r.id === run.id);
    assert.equal(stored?.status, "killed");
  });
});

// ---------------------------------------------------------------------------
// killRun — with persistence
// ---------------------------------------------------------------------------

describe("killRun — with persistence", () => {
  test("appends workflow.run.end with status:killed when recorded", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    const run = makeRun();
    s.recordRunStart(run);

    const result = killRun(run.id, { store: s, persistence: port });
    assert.equal(result.ok, true);
    assert.equal(result.runId, run.id);
    assert.equal(result.previousStatus, "running");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "workflow.run.end");
    assert.equal(calls[0].payload.status, "killed");
    assert.equal(calls[0].payload.runId, run.id);
    assert.equal(typeof calls[0].payload.ts, "number");
  });

  test("does NOT append entry for not_found", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    killRun("missing", { store: s, persistence: port });
    assert.equal(calls.length, 0);
  });

  test("does NOT append entry for already_ended", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    const run = makeRun();
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");
    killRun(run.id, { store: s, persistence: port });
    assert.equal(calls.length, 0);
  });

  test("does NOT append entry when persistence omitted (undefined behavior preserved)", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    // No error, no persistence call — just check it succeeds
    const result = killRun(run.id, { store: s });
    assert.equal(result.ok, true);
    assert.equal(result.runId, run.id);
    assert.equal(result.previousStatus, "running");
  });
});

// ---------------------------------------------------------------------------
// killRun — abort wiring (cancellation checked AFTER run validation)
// ---------------------------------------------------------------------------

describe("killRun — abort wiring", () => {
  test("aborts registered controller on successful kill", () => {
    const s = createStore();
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    const run = makeRun();
    s.recordRunStart(run);
    reg.register(run.id, ctrl);

    killRun(run.id, { store: s, cancellation: reg });
    assert.equal(ctrl.signal.aborted, true);
  });

  test("does NOT abort controller when run not_found (no side-effects)", () => {
    const s = createStore();
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    // Register a DIFFERENT run so we can observe no cross-contamination
    s.recordRunStart(makeRun({ id: "other-run" }));
    reg.register("other-run", ctrl);

    killRun("missing", { store: s, cancellation: reg });
    assert.equal(ctrl.signal.aborted, false);
  });

  test("does NOT abort controller when already_ended", () => {
    const s = createStore();
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    const run = makeRun();
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");
    reg.register(run.id, ctrl);

    killRun(run.id, { store: s, cancellation: reg });
    assert.equal(ctrl.signal.aborted, false);
  });
});

// ---------------------------------------------------------------------------
// killAllRuns — persistence
// ---------------------------------------------------------------------------

describe("killAllRuns — persistence", () => {
  test("appends one workflow.run.end per in-flight run", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    s.recordRunStart(makeRun({ id: "r1", name: "run-one" }));
    s.recordRunStart(makeRun({ id: "r2", name: "run-two" }));

    const results = killAllRuns({ store: s, persistence: port });
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((c) => c.type === "workflow.run.end"), true);
    assert.equal(calls.every((c) => c.payload.status === "killed"), true);
    const killedIds = calls.map((c) => c.payload.runId);
    assert.ok(killedIds.includes("r1"));
    assert.ok(killedIds.includes("r2"));
  });

  test("skips already-ended runs, appends only for in-flight", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    s.recordRunStart(makeRun({ id: "ended" }));
    s.recordRunEnd("ended", "completed");
    s.recordRunStart(makeRun({ id: "live" }));

    killAllRuns({ store: s, persistence: port });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.runId, "live");
  });

  test("no appends when no persistence provided", () => {
    const s = createStore();
    s.recordRunStart(makeRun({ id: "r1" }));
    // Should not throw
    const results = killAllRuns({ store: s });
    assert.equal(results.every((r) => r.ok), true);
  });
});

// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------

describe("resumeRun", () => {
  test("returns snapshot for active run", () => {
    const s = createStore();
    const run = makeRun({ id: "active-1" });
    s.recordRunStart(run);

    const result = resumeRun(run.id, { store: s });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("narrowing");
    assert.equal(result.runId, run.id);
    assert.equal(result.snapshot.id, run.id);
    assert.equal(result.snapshot.status, "running");
  });

  test("returns snapshot for completed run", () => {
    const s = createStore();
    const run = makeRun({ id: "ended-1" });
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");

    const result = resumeRun(run.id, { store: s });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("narrowing");
    assert.equal(result.runId, run.id);
    assert.equal(result.snapshot.status, "completed");
    assert.equal(typeof result.snapshot.endedAt, "number");
  });

  test("returns not_found for unknown runId", () => {
    const s = createStore();
    const result = resumeRun("ghost-run", { store: s });
    assert.deepEqual(result, { ok: false, runId: "ghost-run", reason: "not_found" });
  });

  test("returns deep copy", () => {
    const s = createStore();
    const run = makeRun({ id: "copy-check" });
    s.recordRunStart(run);

    const result = resumeRun(run.id, { store: s });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("narrowing");

    const storedRun = s.runs().find((r) => r.id === run.id);
    assert.notEqual(result.snapshot, storedRun);

    const injectedStage: StageSnapshot = {
      id: "injected",
      name: "injected",
      status: "pending",
      parentIds: [],
      toolEvents: [],
    };
    result.snapshot.stages.push(injectedStage);
    const storedAfter = s.runs().find((r) => r.id === run.id);
    assert.equal(storedAfter?.stages.length, 0);
  });
});
