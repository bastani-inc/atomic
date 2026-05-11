/**
 * Unit tests for compact widget rendering.
 * Tests: renderWidgetLines, buildRunSummaryLine, buildSparkline, formatDuration.
 * cross-ref: spec §5.4.4, §5.4.6, §8.1 Phase E
 */

import { test, expect, describe } from "bun:test";
import {
  renderWidgetLines,
  buildRunSummaryLine,
  buildSparkline,
  formatDuration,
} from "../../src/tui/widget.js";
import type { StoreSnapshot, RunSnapshot, StageSnapshot } from "../../src/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  id: string,
  name: string,
  status: StageSnapshot["status"],
): StageSnapshot {
  return {
    id,
    name,
    status,
    parentIds: [],
    toolEvents: [],
  };
}

function makeRun(
  id: string,
  name: string,
  status: RunSnapshot["status"],
  stages: StageSnapshot[] = [],
  startedAt = Date.now() - 5000,
  endedAt?: number,
): RunSnapshot {
  return {
    id,
    name,
    inputs: {},
    status,
    stages,
    startedAt,
    endedAt,
    durationMs: endedAt !== undefined ? endedAt - startedAt : undefined,
  };
}

function makeSnap(runs: RunSnapshot[]): StoreSnapshot {
  return { runs, version: 1 };
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  test("< 60 s → just seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  test(">= 60 s → minutes + seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(84_000)).toBe("1m 24s");
    expect(formatDuration(3600_000)).toBe("60m 0s");
  });

  test("fractional ms is floored", () => {
    expect(formatDuration(1999)).toBe("1s");
    expect(formatDuration(61_999)).toBe("1m 1s");
  });
});

// ---------------------------------------------------------------------------
// buildSparkline
// ---------------------------------------------------------------------------

describe("buildSparkline", () => {
  test("no stages → empty string", () => {
    const run = makeRun("r1", "test", "running");
    expect(buildSparkline(run)).toBe("");
  });

  test("maps status to glyphs", () => {
    const run = makeRun("r1", "test", "running", [
      makeStage("s1", "a", "completed"),
      makeStage("s2", "b", "running"),
      makeStage("s3", "c", "pending"),
      makeStage("s4", "d", "failed"),
    ]);
    expect(buildSparkline(run)).toBe("█ ▶ · ✗");
  });

  test("truncates to maxWidth", () => {
    const stages = Array.from({ length: 20 }, (_, i) =>
      makeStage(`s${i}`, `stage-${i}`, "completed"),
    );
    const run = makeRun("r1", "test", "running", stages);
    const line = buildSparkline(run, 10);
    expect(line.length).toBeLessThanOrEqual(10);
    expect(line.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRunSummaryLine
// ---------------------------------------------------------------------------

describe("buildRunSummaryLine", () => {
  test("no stages — shows stage 1/0", () => {
    const run = makeRun("r1", "my-workflow", "running", [], Date.now() - 1000);
    const line = buildRunSummaryLine(run);
    expect(line).toContain("▶ my-workflow");
    expect(line).toContain("stage 1");
    expect(line).toContain("⏱");
  });

  test("with stages — counts done and labels active", () => {
    const run = makeRun(
      "r1",
      "deep-research",
      "running",
      [
        makeStage("s1", "scout", "completed"),
        makeStage("s2", "specialist-1", "running"),
        makeStage("s3", "aggregate", "pending"),
      ],
      Date.now() - 84_000,
    );
    const line = buildRunSummaryLine(run);
    expect(line).toContain("▶ deep-research");
    expect(line).toContain("stage 2/3");
    expect(line).toContain("(specialist-1)");
    expect(line).toContain("1m 24s");
  });

  test("uses durationMs for ended runs", () => {
    const now = Date.now();
    const run = makeRun("r1", "wf", "completed", [], now - 10_000, now);
    run.durationMs = 10_000;
    const line = buildRunSummaryLine(run);
    expect(line).toContain("10s");
  });
});

// ---------------------------------------------------------------------------
// renderWidgetLines
// ---------------------------------------------------------------------------

describe("renderWidgetLines", () => {
  test("no runs → empty array", () => {
    const snap = makeSnap([]);
    expect(renderWidgetLines(snap)).toEqual([]);
  });

  test("all runs ended → empty array", () => {
    const now = Date.now();
    const snap = makeSnap([makeRun("r1", "wf", "completed", [], now - 1000, now)]);
    expect(renderWidgetLines(snap)).toEqual([]);
  });

  test("single active run → line 1 only (no stages)", () => {
    const snap = makeSnap([makeRun("r1", "my-wf", "running")]);
    const lines = renderWidgetLines(snap);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("▶ my-wf");
  });

  test("single active run with stages → line 1 + sparkline", () => {
    const run = makeRun("r1", "my-wf", "running", [
      makeStage("s1", "a", "completed"),
      makeStage("s2", "b", "running"),
    ]);
    const snap = makeSnap([run]);
    const lines = renderWidgetLines(snap);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("▶ my-wf");
    expect(lines[1]).toContain("█");
    expect(lines[1]).toContain("▶");
  });

  test("multiple active runs → line 2 multi-run badge + sparkline", () => {
    const run1 = makeRun("r1", "wf-1", "running", [makeStage("s1", "a", "running")]);
    const run2 = makeRun("r2", "wf-2", "running", [makeStage("s2", "b", "running")]);
    const snap = makeSnap([run1, run2]);
    const lines = renderWidgetLines(snap, 80);
    // line 1: primary (most recent = run2)
    expect(lines[0]).toContain("▶ wf-2");
    // line 2: multi-run badge
    expect(lines[1]).toContain("2 runs in flight");
    // line 3: sparkline
    expect(lines[2]).toContain("▶");
  });

  test("respects width — truncates line 1 with ellipsis", () => {
    const run = makeRun("r1", "very-long-workflow-name", "running", [], Date.now() - 100_000);
    const snap = makeSnap([run]);
    const lines = renderWidgetLines(snap, 20);
    expect(lines[0]!.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toMatch(/…$/);
  });

  test("primary run = most recently started active run", () => {
    const run1 = makeRun("r1", "first", "running", [], Date.now() - 2000);
    const run2 = makeRun("r2", "second", "running", [], Date.now() - 100);
    const snap = makeSnap([run1, run2]);
    const lines = renderWidgetLines(snap);
    // run2 is last in array (most recently started)
    expect(lines[0]).toContain("▶ second");
  });
});
