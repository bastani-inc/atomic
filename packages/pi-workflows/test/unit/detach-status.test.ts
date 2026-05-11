/**
 * Unit tests for runs/detach/status.ts (status, kill, resume helpers)
 * cross-ref: spec §8.1 Phase D
 */

import { test, expect, describe } from "bun:test";
import { statusRuns, killRun, killAllRuns, resumeRun } from "../../src/runs/detach/status.js";
import { createStore } from "../../src/store.js";
import type { RunSnapshot } from "../../src/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "r1",
    name: "my-wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// statusRuns
// ---------------------------------------------------------------------------

describe("statusRuns", () => {
  test("returns empty when store has no runs", () => {
    const st = createStore();
    expect(statusRuns({ store: st })).toHaveLength(0);
  });

  test("returns in-flight runs by default", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    const result = statusRuns({ store: st });
    expect(result).toHaveLength(1);
    expect(result[0]!.runId).toBe("r1");
  });

  test("excludes ended runs by default", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunEnd("r1", "completed");
    expect(statusRuns({ store: st })).toHaveLength(0);
  });

  test("includes ended runs when all=true", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunEnd("r1", "completed");
    const result = statusRuns({ all: true, store: st });
    expect(result).toHaveLength(1);
    expect(result[0]!.runId).toBe("r1");
  });

  test("entry has correct shape", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1", name: "test-wf", stages: [] }));
    const entry = statusRuns({ store: st })[0]!;
    expect(entry.runId).toBe("r1");
    expect(entry.name).toBe("test-wf");
    expect(typeof entry.startedAt).toBe("number");
    expect(typeof entry.stageCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// killRun
// ---------------------------------------------------------------------------

describe("killRun", () => {
  test("returns ok:false reason:not_found for unknown runId", () => {
    const st = createStore();
    const result = killRun("nonexistent", { store: st });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  test("returns ok:false reason:already_ended when run has ended", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunEnd("r1", "completed");
    const result = killRun("r1", { store: st });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already_ended");
  });

  test("returns ok:true and marks run as killed", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    const result = killRun("r1", { store: st });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe("r1");
      expect(result.previousStatus).toBe("running");
    }
    const runs = st.runs();
    expect(runs[0]!.status).toBe("killed");
  });
});

// ---------------------------------------------------------------------------
// killAllRuns
// ---------------------------------------------------------------------------

describe("killAllRuns", () => {
  test("returns empty when no runs", () => {
    const st = createStore();
    expect(killAllRuns({ store: st })).toHaveLength(0);
  });

  test("kills all in-flight runs", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunStart(makeRun({ id: "r2", name: "wf2" }));
    const results = killAllRuns({ store: st });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(st.runs().every((r) => r.status === "killed")).toBe(true);
  });

  test("does not kill already-ended runs", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunEnd("r1", "completed");
    const results = killAllRuns({ store: st });
    // No in-flight runs, so returns empty
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------

describe("resumeRun", () => {
  test("returns ok:false reason:not_found for unknown runId", () => {
    const st = createStore();
    const result = resumeRun("nonexistent", { store: st });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  test("returns ok:true with snapshot for still-active run", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
    const result = resumeRun("r1", { store: st });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe("r1");
      expect(result.snapshot.name).toBe("my-wf");
      expect(result.snapshot.status).toBe("running");
    }
  });

  test("returns ok:true with snapshot for ended run", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
    st.recordRunEnd("r1", "completed");
    const result = resumeRun("r1", { store: st });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe("r1");
      expect(result.snapshot.name).toBe("my-wf");
      expect(result.snapshot.status).toBe("completed");
    }
  });

  test("returned snapshot is a deep copy (not a reference)", () => {
    const st = createStore();
    st.recordRunStart(makeRun({ id: "r1" }));
    st.recordRunEnd("r1", "failed");
    const result = resumeRun("r1", { store: st });
    if (result.ok) {
      // Mutating the snapshot should not affect the store
      (result.snapshot as { name: string }).name = "mutated";
      const stored = st.runs().find((r) => r.id === "r1");
      expect(stored!.name).toBe("my-wf");
    }
  });
});
