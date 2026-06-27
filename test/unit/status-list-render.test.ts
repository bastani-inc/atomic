/**
 * Unit tests for the canonical status-list renderer (`src/tui/status-list.ts`).
 *
 * Visual contract from ui/mockups.html §2:
 *   - one rounded `BACKGROUND` panel
 *   - one two-row card per run (replaces the indented per-stage rows)
 *   - per-card row 1: tag (short id) + bold workflow name + state badge
 *   - per-card row 2: mode + progress strip + meta
 *   - trailing hint pointing at `/workflow status <id>`
 *
 * Plain mode preserves rounded panel/card shape without ANSI escapes.
 *
 * cross-ref: src/tui/status-list.ts · src/tui/chat-surface.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function makeStage(
  id: string,
  name: string,
  status: StageSnapshot["status"],
  extras: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    id,
    name,
    status,
    parentIds: [],
    toolEvents: [],
    ...extras,
  };
}

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
  return {
    id: over.id ?? "abc123uuid",
    name: over.name ?? "refactor-auth",
    inputs: over.inputs ?? {},
    status: over.status ?? "running",
    stages: over.stages ?? [],
    startedAt: over.startedAt ?? Date.now() - 5000,
    endedAt: over.endedAt,
    durationMs: over.durationMs,
    pausedDurationMs: over.pausedDurationMs,
    pausedAt: over.pausedAt,
    resumedAt: over.resumedAt,
    result: over.result,
    error: over.error,
    exited: over.exited,
    exitReason: over.exitReason,
    resumable: over.resumable,
  };
}

describe("renderStatusList — empty", () => {
  test("emits the rounded panel header + empty-state copy when no runs", () => {
    const out = renderStatusList([], { theme: deriveGraphTheme({}), width: 120 });
    const plain = stripAnsi(out);
    assert.match(plain, /╭ BACKGROUND  0 runs /);
    assert.match(plain, /0 runs/);
    assert.match(plain, /no workflow runs in current session/);
  });
});

describe("renderStatusList — populated", () => {
  test("multi-run snapshot renders header counts, cards, and a drill-down hint — without listing every stage", () => {
    const now = 1_000_000;
    const runs: RunSnapshot[] = [
      makeRun({
        id: "abc123uuid",
        name: "refactor-auth",
        status: "running",
        startedAt: now - 117_000,
        stages: [
          makeStage("s1", "scout", "completed", { startedAt: now - 117_000, endedAt: now - 72_000, durationMs: 45_000 }),
          makeStage("s2", "planner", "running", { parentIds: ["s1"], startedAt: now - 72_000 }),
          makeStage("s3", "worker", "pending", { parentIds: ["s2"] }),
        ],
      }),
      makeRun({
        id: "def456uuid",
        name: "doc-update",
        status: "running",
        startedAt: now - 42_000,
        stages: [makeStage("w1", "writer", "running", { startedAt: now - 42_000 })],
      }),
      makeRun({
        id: "ghi789uuid",
        name: "scan-deps",
        status: "completed",
        startedAt: now - 16_000,
        endedAt: now - 8_000,
        durationMs: 8_000,
        stages: [makeStage("z1", "primer", "completed", { durationMs: 8_000 })],
      }),
    ];
    const out = renderStatusList(runs, { theme: deriveGraphTheme({}), now, width: 120 });
    const plain = stripAnsi(out);

    // Panel header — chrome + subtitle + count badges.
    assert.match(plain, /╭ BACKGROUND  3 runs /);
    assert.match(plain, /3 runs/);
    assert.match(plain, /● 2/, "two active runs");
    assert.match(plain, /✓ 1/, "one completed run");

    // One card per run — tag + bold workflow + state badge.
    assert.match(plain, /abc123\s+refactor-auth/);
    assert.match(plain, /def456\s+doc-update/);
    assert.match(plain, /ghi789\s+scan-deps/);
    assert.match(plain, /● running/);
    assert.match(plain, /✓ completed/);

    // Row 2 — mode + progress strip + meta.
    assert.match(plain, /chain\s+\[✓\]\[●\]\[○\]/);
    assert.match(plain, /1\/3/, "chain progress fraction renders in meta");
    assert.match(plain, /single\s+\[●\]/);
    assert.match(plain, /single\s+\[✓\]/);
    assert.match(plain, /loop\s+scout → planner → worker/, "loop row appears under the chain row");
    assert.doesNotMatch(plain, /loop\s+writer/);
    assert.doesNotMatch(plain, /loop\s+primer/);

    // Run entries are compact rows, not per-stage expansion in list view.
    const runRows = plain.split("\n").filter((l) => /[●✓✗⊘○]\s+[a-z0-9]{6}\s+/.test(l));
    assert.equal(runRows.length, 3, "3 runs × 1 identity row");

    // Trailing hint references the most-recently-active run (def456, 42s ago).
    assert.match(plain, /▸ \/workflow status def456/);
    assert.match(plain, /drill into a run/);
  });

  test("quit run renders as resumable instead of failed", () => {
    const out = renderStatusList([
      makeRun({
        id: "quit123uuid",
        name: "resume-me",
        status: "paused",
        exitReason: "quit",
        resumable: true,
      }),
    ], { width: 120 });
    const plain = stripAnsi(out);
    assert.match(plain, /BACKGROUND  1 run  1 quit/);
    assert.match(plain, /resume-me/);
    assert.match(plain, /resumable via \/workflow resume/);
    assert.doesNotMatch(plain, /failed/);
  });

  test("mixed running and paused snapshot keeps paused runs out of running counts and labels their rows", () => {
    const now = 1_000_000;
    const runs: RunSnapshot[] = [
      makeRun({
        id: "run111uuid",
        name: "active-wf",
        status: "running",
        startedAt: now - 4_000,
        stages: [makeStage("r1", "worker", "running", { startedAt: now - 4_000 })],
      }),
      makeRun({
        id: "pause222uuid",
        name: "paused-wf",
        status: "paused",
        startedAt: now - 10_000,
        pausedAt: now - 6_000,
        stages: [makeStage("p1", "review", "paused", { startedAt: now - 10_000, pausedAt: now - 6_000 })],
      }),
    ];

    const out = renderStatusList(runs, { theme: deriveGraphTheme({}), now, width: 120, showDetailHint: false });
    const plain = stripAnsi(out);

    assert.match(plain, /╭ BACKGROUND  2 runs /);
    assert.match(plain, /● 1/, "only the running run contributes to the running count");
    assert.doesNotMatch(plain, /● 2/, "paused run must not be counted as running");
    assert.match(plain, /❚❚ 1 paused/, "paused count is rendered separately");

    const runningRow = plain.split("\n").find((line) => line.includes("active-wf"));
    assert.ok(runningRow, "running run row is present");
    assert.match(runningRow, /● running/);

    const pausedRow = plain.split("\n").find((line) => line.includes("paused-wf"));
    assert.ok(pausedRow, "paused run row is present");
    assert.match(pausedRow, /❚❚\s+pause2\s+paused-wf\s+❚❚ paused/);
    assert.doesNotMatch(pausedRow, /○ pending/);
    assert.doesNotMatch(pausedRow, /● running/);
  });

  test("plain paused status output is ANSI-free and uses paused glyph and label", () => {
    const now = 1_000_000;
    const run = makeRun({
      id: "pause333uuid",
      name: "paused-plain",
      status: "paused",
      startedAt: now - 10_000,
      pausedAt: now - 6_000,
      stages: [makeStage("p1", "worker", "paused", { startedAt: now - 10_000, pausedAt: now - 6_000 })],
    });

    const out = renderStatusList([run], { width: 100, now, showDetailHint: false });

    assert.doesNotMatch(out, /\x1b\[/);
    assert.match(out, /^╭ BACKGROUND  1 run /);
    assert.match(out, /❚❚ 1 paused/);
    assert.match(out, /❚❚\s+pause3\s+paused-plain\s+❚❚ paused/);
    assert.match(out, /single\s+\[❚❚\]/, "paused progress cell uses the paused glyph, not the pending cell");
    assert.doesNotMatch(out, /○ pending/);
    assert.doesNotMatch(out, /● 1(?:\s+running)?/);
  });

  test("active runs sort ahead of ended runs", () => {
    const now = 1_000_000;
    const ended = makeRun({
      id: "endedrun",
      name: "old-run",
      status: "completed",
      startedAt: now - 60_000,
      endedAt: now - 10_000,
    });
    const active = makeRun({
      id: "activerun",
      name: "fresh-run",
      status: "running",
      startedAt: now - 30_000,
    });
    const out = renderStatusList([ended, active], { theme: deriveGraphTheme({}), now, width: 120 });
    const plain = stripAnsi(out);
    const activeIdx = plain.indexOf("fresh-run");
    const endedIdx = plain.indexOf("old-run");
    assert.ok(activeIdx >= 0 && endedIdx >= 0);
    assert.ok(activeIdx < endedIdx, "active runs render above ended runs");
  });

  test("plain mode (no theme) preserves the band + card shape and emits no ANSI escapes", () => {
    const run = makeRun({
      id: "xyz000aaaa",
      name: "scratch",
      status: "running",
      startedAt: Date.now() - 1000,
      stages: [makeStage("x", "worker", "running")],
    });
    const out = renderStatusList([run], { width: 80 });
    assert.doesNotMatch(out, /\x1b\[/);
    assert.match(out, /^╭ BACKGROUND  1 run /, "plain panel is rounded");
    assert.doesNotMatch(out, /\u258e/);
    assert.match(out, /●\s+xyz000/, "plain entry has status glyph and run id");
    assert.match(out, /scratch/);
    assert.match(out, /single\s+\[●\]/);
    assert.doesNotMatch(out, /loop\s+worker/);
    assert.match(out, /▸ \/workflow status xyz000/);
  });

  test("loop row aligns with chain progress and is hidden for terminal runs", () => {
    const now = 1_000_000;
    const active = makeRun({
      id: "active-loop",
      name: "active-loop",
      status: "running",
      stages: [
        makeStage("a", "scout", "completed"),
        makeStage("b", "worker", "running", { parentIds: ["a"] }),
      ],
    });
    const done = makeRun({
      id: "done-loop",
      name: "done-loop",
      status: "completed",
      startedAt: now - 10_000,
      endedAt: now - 1_000,
      stages: [
        makeStage("c", "scout", "completed"),
        makeStage("d", "worker", "completed", { parentIds: ["c"] }),
      ],
    });

    const plain = stripAnsi(renderStatusList([active, done], { theme: deriveGraphTheme({}), now, width: 100, showDetailHint: false }));
    assert.match(plain, /chain\s+\[✓\]\[●\]/);
    const chainLine = plain.split("\n").find((line) => line.includes("[✓][●]"));
    const loopLine = plain.split("\n").find((line) => line.includes("scout → worker"));
    assert.ok(chainLine);
    assert.ok(loopLine);
    assert.equal(chainLine.indexOf("[✓]"), loopLine.indexOf("scout"));
    assert.equal(plain.split("\n").filter((line) => /loop\s+scout → worker/.test(line)).length, 1);
  });

  test("builtin loop row uses runner defaults for non-positive limits", () => {
    const run = makeRun({
      id: "ralph0uuid",
      name: "ralph",
      status: "running",
      inputs: { max_loops: 0 },
      stages: [makeStage("orch", "orchestrator-1", "running")],
    });

    const plain = stripAnsi(renderStatusList([run], { width: 110, showDetailHint: false }));
    assert.match(plain, /loop\s+prompt-refine → research → orchestrator → review ×3 · ↻ 9 rounds remain/);
    assert.doesNotMatch(plain, /0 rounds remain/);
  });

  test("failed run carries the killed/failed-at-stage meta", () => {
    const now = 1_000_000;
    const run = makeRun({
      id: "kill0aaa",
      name: "deep-research-codebase",
      status: "killed",
      startedAt: now - 4_000,
      endedAt: now - 1_000,
      stages: [
        makeStage("s1", "scout", "completed", { durationMs: 22_000 }),
        makeStage("s2", "partition", "failed", { durationMs: 0 }),
      ],
    });
    const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width: 120 });
    const plain = stripAnsi(out);
    assert.match(plain, /⊘ killed/);
    assert.match(plain, /failed at partition/);
  });

  test("terminal ctx.exit rows include the author reason in list meta", () => {
    const now = 1_000_000;
    const runs: RunSnapshot[] = [
      makeRun({
        id: "exitcmpl",
        name: "exit-completed",
        status: "completed",
        exited: true,
        exitReason: "guard completed early",
        startedAt: now - 12_000,
        endedAt: now - 2_000,
        stages: [makeStage("c1", "guard", "completed", { durationMs: 10_000 })],
      }),
      makeRun({
        id: "exitskip",
        name: "exit-skipped",
        status: "skipped",
        exited: true,
        exitReason: "nothing to process",
        startedAt: now - 8_000,
        endedAt: now - 1_000,
        stages: [makeStage("s1", "scan", "skipped", { durationMs: 7_000 })],
      }),
    ];

    const out = renderStatusList(runs, { width: 120, now, showDetailHint: false });

    assert.match(out, /guard completed early/);
    assert.match(out, /nothing to process/);
    assert.match(out, /✓ completed/);
    assert.match(out, /⊘ skipped/);
  });

  test("narrow width truncates progress strip with …", () => {
    const now = 1_000_000;
    const stages = Array.from({ length: 12 }, (_, i) => makeStage(`s${i}`, `stage-${i}`, i < 3 ? "completed" : i === 3 ? "running" : "pending"));
    const run = makeRun({
      id: "7c4a91xx",
      name: "ent-deep-research",
      status: "running",
      startedAt: now - 60_000,
      stages,
    });
    const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width: 60 });
    const plain = stripAnsi(out);
    // Strip must truncate to fit the 60-column width.
    assert.match(plain, /\[…\]|\]…|…/, "ellipsis present on narrow strip");
  });

  test("long and wide run/stage names stay within the requested line width", () => {
    const now = 1_000_000;
    const width = 64;
    const run = makeRun({
      id: "wide99uuid",
      name: "研究".repeat(18) + "-status-list-overflow",
      status: "running",
      startedAt: now - 60_000,
      stages: [
        makeStage("s1", "scout", "completed", { durationMs: 10_000 }),
        makeStage("s2", "正在运行".repeat(12), "running", { startedAt: now - 30_000 }),
      ],
    });
    const out = renderStatusList([run], { theme: deriveGraphTheme({}), now, width });
    for (const line of out.split("\n")) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
    }
    assert.match(stripAnsi(out), /…/);
  });
});
