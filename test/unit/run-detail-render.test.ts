/**
 * Unit tests for the per-run detail renderer (`src/tui/run-detail.ts`)
 * and the `inspectRun()` lookup helper that feeds it.
 *
 * cross-ref: src/tui/run-detail.ts · src/runs/background/status.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderRunDetail } from "../../src/tui/run-detail.js";
import { inspectRun } from "../../src/runs/background/status.js";
import { createStore } from "../../src/shared/store.js";
import { deriveGraphTheme } from "../../src/tui/graph-theme.js";
import type { RunDetail } from "../../src/runs/background/status.js";
import type { RunSnapshot, StageSnapshot } from "../../src/shared/store-types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function makeStage(
  id: string,
  name: string,
  status: StageSnapshot["status"],
  extras: Partial<StageSnapshot> = {},
): StageSnapshot {
  return { id, name, status, parentIds: [], toolEvents: [], ...extras };
}

function makeRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: over.id ?? "abc123uuid",
    name: over.name ?? "refactor-auth",
    inputs: over.inputs ?? {},
    status: over.status ?? "running",
    stages: over.stages ?? [],
    startedAt: over.startedAt ?? 1000,
    endedAt: over.endedAt,
    durationMs: over.durationMs,
    result: over.result,
    error: over.error,
  };
}

function detailFromRun(run: RunSnapshot): RunDetail {
  return {
    runId: run.id,
    name: run.name,
    status: run.status,
    mode: run.stages.length > 1 ? "chain" : "single",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    inputs: run.inputs,
    stages: run.stages,
    result: run.result,
    error: run.error,
  };
}

// ---------------------------------------------------------------------------
// inspectRun
// ---------------------------------------------------------------------------

describe("inspectRun", () => {
  test("returns ok:false not_found for unknown id", () => {
    const store = createStore();
    const result = inspectRun("nonexistent", { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "not_found");
  });

  test("returns detail for active run", () => {
    const store = createStore();
    store.recordRunStart(makeRun({ id: "abc123uuid", name: "wf", status: "running" }));
    const result = inspectRun("abc123uuid", { store });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.detail.runId, "abc123uuid");
      assert.equal(result.detail.mode, "single");
      assert.equal(result.detail.status, "running");
    }
  });

  test("resolves a short prefix to a single matching run", () => {
    const store = createStore();
    store.recordRunStart(makeRun({ id: "abc123full-uuid", name: "wf" }));
    const result = inspectRun("abc123", { store });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.detail.runId, "abc123full-uuid");
  });

  test("derives mode=chain when stage count > 1", () => {
    const store = createStore();
    store.recordRunStart(makeRun({
      id: "chainrun",
      stages: [
        makeStage("s1", "a", "running"),
        makeStage("s2", "b", "pending"),
      ],
    }));
    const result = inspectRun("chainrun", { store });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.detail.mode, "chain");
  });
});

// ---------------------------------------------------------------------------
// renderRunDetail
// ---------------------------------------------------------------------------

describe("renderRunDetail — themed", () => {
  test("emits band header, stages section, and a cancel hint for an active run", () => {
    const now = 1_000_000;
    const run = makeRun({
      id: "abc123uuid",
      name: "refactor-auth",
      status: "running",
      startedAt: now - 117_000,
      stages: [
        makeStage("s1", "scout", "completed", { durationMs: 45_000 }),
        makeStage("s2", "planner", "running", { startedAt: now - 72_000 }),
        makeStage("s3", "worker", "pending"),
      ],
    });
    const detail = detailFromRun(run);
    const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now });
    const plain = stripAnsi(out);

    // Band header — pill carries short id, subtitle carries workflow name.
    assert.match(plain, /RUN abc123/);
    assert.match(plain, /refactor-auth/);
    assert.match(plain, /● running/);

    // STAGES section label + stage glyphs.
    assert.match(plain, /▎ STAGES/);
    assert.match(plain, /✓ scout/);
    assert.match(plain, /● planner/);
    assert.match(plain, /○ worker/);

    // Active run gets the interrupt action hint (shortId crops to 6 chars).
    assert.match(plain, /workflow interrupt\s+id=abc123/);
    assert.doesNotMatch(plain, /workflow resume/);
    // Pill label uses the short id too.
    assert.match(plain, /RUN abc123/);
  });

  test("ended run swaps the action hint to resume and reports duration", () => {
    const now = 1_000_000;
    const detail = detailFromRun(makeRun({
      id: "donerunid",
      name: "scan-deps",
      status: "completed",
      startedAt: now - 60_000,
      endedAt: now - 8_000,
      durationMs: 52_000,
      stages: [makeStage("s1", "scan", "completed", { durationMs: 52_000 })],
    }));
    const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now });
    const plain = stripAnsi(out);
    assert.match(plain, /✓ completed/);
    // shortId() crops the pill label and the action hint to 6 chars.
    assert.match(plain, /workflow resume\s+id=doneru/);
    assert.match(plain, /duration/);
    assert.doesNotMatch(plain, /workflow interrupt/);
  });
});

describe("renderRunDetail — plain", () => {
  test("plain mode (no theme) is ASCII-safe and includes the band chrome", () => {
    // shortId() truncates run ids to 6 chars for the pill label.
    const detail = detailFromRun(makeRun({ id: "scratch01" }));
    const out = renderRunDetail(detail);
    assert.doesNotMatch(out, /\x1b\[/);
    assert.match(out, /╭─+╮/);
    assert.match(out, /│ RUN scratc │/);
    assert.match(out, /╰─+╯/);
  });
});
