/**
 * Focused tests for killRun / killAllRuns kill-controls persistence wiring.
 * cross-ref: spec §8.1 Phase D — persist-kill-controls
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { killRun, killAllRuns } from "./status.js";
import { createStore } from "../../store.js";
import { createCancellationRegistry } from "./cancellation-registry.js";
import type { WorkflowPersistencePort } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<{ id: string; name: string; status: "running" | "killed" | "completed" }> = {}) {
  return {
    id: overrides.id ?? "run-1",
    name: overrides.name ?? "test-run",
    inputs: {},
    status: (overrides.status ?? "running") as "running",
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
// killRun — no persistence (backward compat)
// ---------------------------------------------------------------------------

describe("killRun — no persistence", () => {
  test("returns ok:false not_found for unknown runId", () => {
    const s = createStore();
    const result = killRun("unknown", { store: s });
    expect(result).toEqual({ ok: false, runId: "unknown", reason: "not_found" });
  });

  test("returns ok:false already_ended for ended run", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");
    const result = killRun(run.id, { store: s });
    expect(result).toEqual({ ok: false, runId: run.id, reason: "already_ended" });
  });

  test("kills in-flight run, returns ok:true with previousStatus", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    const result = killRun(run.id, { store: s });
    expect(result).toEqual({ ok: true, runId: run.id, previousStatus: "running" });
    const stored = s.runs().find((r) => r.id === run.id);
    expect(stored?.status).toBe("killed");
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
    expect(result).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("workflow.run.end");
    expect(calls[0].payload.status).toBe("killed");
    expect(calls[0].payload.runId).toBe(run.id);
    expect(typeof calls[0].payload.ts).toBe("number");
  });

  test("does NOT append entry for not_found", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    killRun("missing", { store: s, persistence: port });
    expect(calls).toHaveLength(0);
  });

  test("does NOT append entry for already_ended", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    const run = makeRun();
    s.recordRunStart(run);
    s.recordRunEnd(run.id, "completed");
    killRun(run.id, { store: s, persistence: port });
    expect(calls).toHaveLength(0);
  });

  test("does NOT append entry when persistence omitted (undefined behavior preserved)", () => {
    const s = createStore();
    const run = makeRun();
    s.recordRunStart(run);
    // No error, no persistence call — just check it succeeds
    const result = killRun(run.id, { store: s });
    expect(result).toMatchObject({ ok: true });
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
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("does NOT abort controller when run not_found (no side-effects)", () => {
    const s = createStore();
    const reg = createCancellationRegistry();
    const ctrl = new AbortController();
    // Register a DIFFERENT run so we can observe no cross-contamination
    s.recordRunStart(makeRun({ id: "other-run" }));
    reg.register("other-run", ctrl);

    killRun("missing", { store: s, cancellation: reg });
    expect(ctrl.signal.aborted).toBe(false);
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
    expect(ctrl.signal.aborted).toBe(false);
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
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.type === "workflow.run.end")).toBe(true);
    expect(calls.every((c) => c.payload.status === "killed")).toBe(true);
    const killedIds = calls.map((c) => c.payload.runId);
    expect(killedIds).toContain("r1");
    expect(killedIds).toContain("r2");
  });

  test("skips already-ended runs, appends only for in-flight", () => {
    const s = createStore();
    const { port, calls } = makePersistence();
    s.recordRunStart(makeRun({ id: "ended" }));
    s.recordRunEnd("ended", "completed");
    s.recordRunStart(makeRun({ id: "live" }));

    killAllRuns({ store: s, persistence: port });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.runId).toBe("live");
  });

  test("no appends when no persistence provided", () => {
    const s = createStore();
    s.recordRunStart(makeRun({ id: "r1" }));
    // Should not throw
    const results = killAllRuns({ store: s });
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
