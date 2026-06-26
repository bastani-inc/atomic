/**
 * Unit tests for the background-workflow widget.
 *
 * Visual contract:
 *   - One transparent rounded `BACKGROUND` panel with `N runs` subtitle and
 *     status-icon count badges in the title.
 *   - Two-line entry per run (status glyph + short id + bold name on
 *     line 1; dim mode · progress · duration on line 2).
 *   - Blank line between entries, no trailing blank.
 *   - Collapsed single-line form below 80 cells.
 *   - Hides entirely (returns []) when no active or recently-ended runs.
 *
 * cross-ref: src/tui/widget.ts · orchestrator-panel-ui.png · DESIGN.md §5
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  renderWidgetLines,
  buildThemedWidgetLines,
  formatDuration,
  nextWidgetRefreshDelayMs,
  RECENT_ENDED_WINDOW_MS,
} from "../../packages/workflows/src/tui/widget.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import type {
  StoreSnapshot,
  RunSnapshot,
  StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  id: string,
  name: string,
  status: StageSnapshot["status"],
): StageSnapshot {
  return { id, name, status, parentIds: [], toolEvents: [] };
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
  return { runs, notices: [], version: 1 };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const NULL_PI_THEME = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  test("< 60 s → just seconds", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(5000), "5s");
    assert.equal(formatDuration(59_000), "59s");
  });

  test(">= 60 s → minutes + seconds (no trailing 0s)", () => {
    assert.equal(formatDuration(60_000), "1m");
    assert.equal(formatDuration(84_000), "1m 24s");
    assert.equal(formatDuration(3540_000), "59m");
  });

  test(">= 1 hour → hours + minutes (no trailing 0m)", () => {
    assert.equal(formatDuration(3600_000), "1h");
    assert.equal(formatDuration(3720_000), "1h 2m");
  });

  test("negative ms is clamped to zero", () => {
    assert.equal(formatDuration(-100), "0s");
  });
});

// ---------------------------------------------------------------------------
// renderWidgetLines — empty + hidden states
// ---------------------------------------------------------------------------

describe("renderWidgetLines — hidden states", () => {
  test("no runs → empty array (widget hides)", () => {
    assert.deepEqual(renderWidgetLines(makeSnap([])), []);
  });

  test("all runs ended over 30s ago → empty array", () => {
    const now = Date.now();
    const snap = makeSnap([
      makeRun("r1", "wf", "completed", [], now - 90_000, now - 60_000),
    ]);
    assert.deepEqual(renderWidgetLines(snap), []);
  });
});

// ---------------------------------------------------------------------------
// renderWidgetLines — standard form (≥ 80 cols)
// ---------------------------------------------------------------------------

describe("renderWidgetLines — standard form", () => {
  test("single active run → rounded panel + 2-line entry (4 lines total)", () => {
    const snap = makeSnap([makeRun("abc123uuid", "my-wf", "running")]);
    const lines = renderWidgetLines(snap, 120).map(stripAnsi);
    // top border + 2 content rows + bottom border = 4 total
    assert.equal(lines.length, 4);
    assert.ok(lines[0]!.includes("BACKGROUND"), "header should include BACKGROUND label");
    assert.ok(lines[0]!.includes("1 run"), "header should include 1 run subtitle");
    assert.ok(lines[1]!.includes("abc123"), "line 1 should include short id");
    assert.ok(lines[1]!.includes("my-wf"), "line 1 should include workflow name");
    assert.ok(lines[2]!.includes("single"), "line 2 should describe mode");
  });

  test("quit run renders resumable quit badge and note", () => {
    const run: RunSnapshot = {
      ...makeRun("quit1234", "resume-me", "paused"),
      exitReason: "quit",
      resumable: true,
    };
    const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
    const joined = lines.join("\n");
    assert.ok(lines[0]!.includes("BACKGROUND  1 run  1 quit"));
    assert.ok(joined.includes("quit · resumable via /workflow resume"));
  });

  test("running run shows chain mode when multi-stage", () => {
    const run = makeRun("xyz000aaaa", "deep-research", "running", [
      makeStage("s1", "scout", "completed"),
      makeStage("s2", "specialist", "running"),
      makeStage("s3", "aggregate", "pending"),
    ]);
    const lines = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi);
    const metaLine = lines[2]!;
    assert.ok(metaLine.includes("chain"), "multi-stage run reads as chain");
    assert.ok(metaLine.includes("1/3"), "progress count includes done/total");
  });

  test("multiple active runs → header subtitle pluralises, entries stacked with blank separators", () => {
    const t = Date.now();
    const r1 = makeRun("aaa111zzz", "wf-one", "running", [], t - 2000);
    const r2 = makeRun("bbb222zzz", "wf-two", "running", [], t - 100);
    const lines = renderWidgetLines(makeSnap([r1, r2]), 120).map(stripAnsi);
    assert.ok(lines[0]!.includes("2 runs"));
    const joined = lines.join("\n");
    assert.ok(joined.includes("wf-one"));
    assert.ok(joined.includes("wf-two"));
    // Most-recently-started run is shown first.
    const wfTwoIdx = lines.findIndex((l) => l.includes("wf-two"));
    const wfOneIdx = lines.findIndex((l) => l.includes("wf-one"));
    assert.ok(wfTwoIdx < wfOneIdx, "most recently started run renders first");
  });

  test("hides nested child workflow runs, showing only the top-level run", () => {
    const t = Date.now();
    const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
    const parent: RunSnapshot = {
      ...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
      parentRunId: "root1111",
      parentStageId: "hil-parent:imported-composition",
      rootRunId: "root1111",
    };
    const child: RunSnapshot = {
      ...makeRun("child333", "contract-hil-nested-child", "running", [], t - 1000),
      parentRunId: "parent22",
      parentStageId: "hil-child:imported",
      rootRunId: "root1111",
    };
    const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
    const joined = lines.join("\n");
    // Only the top-level root is listed; the count reflects one run, not three.
    assert.ok(lines[0]!.includes("1 run"), `expected "1 run" subtitle, got: ${lines[0]}`);
    assert.ok(joined.includes("contract-hil-nested-root"));
    assert.ok(!joined.includes("contract-hil-nested-parent"), "nested parent run must be hidden");
    assert.ok(!joined.includes("contract-hil-nested-child"), "nested child run must be hidden");
  });

  test("surfaces a hidden nested child's awaiting-input (HiL) state on the top-level run", () => {
    const t = Date.now();
    // Root is running and blocked on its imported composition; the actual HiL
    // prompt is awaiting in the nested child run, which the widget hides.
    const root = makeRun("root1111", "contract-hil-nested-root", "running", [], t - 3000);
    const parent: RunSnapshot = {
      ...makeRun("parent22", "contract-hil-nested-parent", "running", [], t - 2000),
      parentRunId: "root1111",
      rootRunId: "root1111",
    };
    const child: RunSnapshot = {
      ...makeRun("child333", "contract-hil-nested-child", "running", [
        makeStage("s1", "ask", "awaiting_input"),
      ], t - 1000),
      parentRunId: "parent22",
      rootRunId: "root1111",
    };
    const lines = renderWidgetLines(makeSnap([child, parent, root]), 120).map(stripAnsi);
    const header = lines[0]!;
    // Only the root is listed, but its hidden descendant's awaiting state still
    // raises the "needs attention" badge so the HiL prompt is discoverable.
    assert.ok(header.includes("1 run"), `expected "1 run" subtitle, got: ${header}`);
    assert.ok(
      header.includes("↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
      `expected nested HiL to surface a needs-attention badge, got: ${header}`,
    );
    assert.ok(!lines.join("\n").includes("contract-hil-nested-child"), "nested child stays hidden");
  });

  test("count badges include stage-local awaiting input", () => {
    const awaiting = makeRun("r1xxxxxx", "wf-await", "running", [
      makeStage("s1", "ask", "awaiting_input"),
    ]);
    const lines = renderWidgetLines(makeSnap([awaiting]), 120).map(stripAnsi);
    const header = lines[0]!;
    assert.ok(header.includes("● 1 running"), "run remains active");
    assert.ok(
      header.includes("？ ↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
      "awaiting-input badge is labeled with status and attach action",
    );
  });

  test("count badges reflect status mix", () => {
    const t = Date.now();
    const running = makeRun("r1xxxxxx", "wf-r", "running", [], t - 1000);
    const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], t - 3000);
    const done = makeRun("r2xxxxxx", "wf-d", "completed", [], t - 5000, t - 1000);
    const failed = makeRun("r3xxxxxx", "wf-f", "failed", [], t - 4000, t - 500);
    const lines = renderWidgetLines(makeSnap([running, paused, done, failed]), 120).map(stripAnsi);
    const header = lines[0]!;
    assert.ok(header.includes("● 1 running"), "running badge");
    assert.ok(header.includes("❚❚ 1 paused"), "paused badge");
    assert.ok(header.includes("✓ 1 complete"), "completed badge");
    assert.ok(header.includes("✗ 1 failed"), "failed badge");
  });

  test("ctx.exit terminal statuses count as complete in the widget header", () => {
    const t = Date.now();
    const skipped = makeRun("s1xxxxxx", "wf-s", "skipped", [], t - 5000, t - 3000);
    const cancelled = makeRun("c1xxxxxx", "wf-c", "cancelled", [], t - 4000, t - 2000);
    const blocked = makeRun("b1xxxxxx", "wf-b", "blocked", [], t - 3000, t - 1000);
    const lines = renderWidgetLines(makeSnap([skipped, cancelled, blocked]), 120).map(stripAnsi);
    const header = lines[0]!;

    assert.ok(header.includes("3 runs"), `expected exited runs in header total, got: ${header}`);
    assert.ok(header.includes("✓ 3 complete"), `expected exited runs in complete badge, got: ${header}`);
    assert.ok(lines.join("\n").includes("skipped · 2s"), "skipped row remains visible");
    assert.ok(lines.join("\n").includes("cancelled · 2s"), "cancelled row remains visible");
    assert.ok(lines.join("\n").includes("blocked · 2s"), "blocked row remains visible");
  });

  test("terminal rows render final duration without ticking ago labels", () => {
    const originalNow = Date.now;
    try {
      const startedAt = 1_000;
      const endedAt = 11_000;
      const completed = makeRun("r2xxxxxx", "wf-d", "completed", [], startedAt, endedAt);
      const failed = makeRun("r3xxxxxx", "wf-f", "failed", [], startedAt, endedAt);
      const killed = makeRun("r4xxxxxx", "wf-k", "killed", [], startedAt, endedAt);
      completed.durationMs = undefined;
      failed.durationMs = undefined;
      killed.durationMs = undefined;

      Date.now = () => 12_000;
      const at12s = renderWidgetLines(makeSnap([completed, failed, killed]), 120).map(stripAnsi).join("\n");
      Date.now = () => 29_000;
      const at29s = renderWidgetLines(makeSnap([completed, failed, killed]), 120).map(stripAnsi).join("\n");

      assert.match(at12s, /complete · 10s/);
      assert.match(at12s, /failed · 10s/);
      assert.match(at12s, /killed · 10s/);
      assert.doesNotMatch(at12s, /ago/);
      assert.equal(at29s, at12s);
    } finally {
      Date.now = originalNow;
    }
  });

  test("paused run renders pause status and frozen active elapsed time", () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 71_000;
      const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], 1_000);
      paused.pausedAt = 11_000;
      const lines = renderWidgetLines(makeSnap([paused]), 120).map(stripAnsi);
      assert.ok(lines.join("\n").includes("❚❚"), "paused glyph");
      assert.ok(lines[0]!.includes("❚❚ 1 paused"), "paused badge");
      assert.match(lines[2]!, /10s/);
      assert.doesNotMatch(lines[2]!, /1m/);

      Date.now = () => 76_000;
      const later = renderWidgetLines(makeSnap([paused]), 120).map(stripAnsi);
      assert.equal(later[2], lines[2]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("terminal and fully paused widgets do not schedule second-boundary refreshes", () => {
    const now = 1_000_000;
    const terminal = makeRun("r2xxxxxx", "wf-d", "completed", [], now - 20_000, now - 10_000);
    const terminalDelay = nextWidgetRefreshDelayMs(makeSnap([terminal]), now);
    assert.equal(terminalDelay, RECENT_ENDED_WINDOW_MS - 10_000 + 1);

    const paused = makeRun("r4xxxxxx", "wf-p", "paused", [], now - 20_000);
    paused.pausedAt = now - 5_000;
    assert.equal(nextWidgetRefreshDelayMs(makeSnap([paused]), now), undefined);
  });

  test("standard panel scales to the provided terminal width", () => {
    const width = 120;
    const snap = makeSnap([makeRun("abc123uuid", "my-wf", "running")]);
    const lines = renderWidgetLines(snap, width);
    for (const line of lines) {
      assert.equal(visibleWidth(line), width);
    }
  });

  test("running run uses static ● glyph, never a braille spinner frame", () => {
    // The widget is the canonical 'workflow status' surface; per DESIGN.md
    // 'no spinners on prompt; no flash' it must render the same static
    // vocabulary as `renderStatusList`/`renderRunDetail` (statusIcon → '●').
    const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const t = Date.now();
    const snap = makeSnap([
      makeRun("r1xxxxxx", "wf-r", "running", [makeStage("s1", "stage-1", "running")], t - 1000),
    ]);
    // Sample several `now` offsets — a frame-cycling glyph would land on
    // a different braille character at each tick.
    for (let dt = 0; dt < 800; dt += 80) {
      const lines = renderWidgetLines(snap, 120).map(stripAnsi);
      const joined = lines.join("\n");
      assert.ok(joined.includes("●"), `static ● glyph at +${dt}ms`);
      for (const frame of SPINNER_FRAMES) {
        assert.ok(
          !joined.includes(frame),
          `widget must not emit braille spinner frame ${JSON.stringify(frame)} at +${dt}ms`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// renderWidgetLines — collapsed form (< 80 cols)
// ---------------------------------------------------------------------------

describe("renderWidgetLines — collapsed form", () => {
  test("returns single line summary under threshold", () => {
    const r1 = makeRun("aaa", "wf-a", "running");
    const r2 = makeRun("bbb", "wf-b", "running");
    const lines = renderWidgetLines(makeSnap([r1, r2]), 60).map(stripAnsi);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("▾"));
    assert.ok(lines[0]!.includes("2 background"));
    assert.ok(lines[0]!.includes("2 ●"));
  });
});

// ---------------------------------------------------------------------------
// buildThemedWidgetLines — ANSI path includes Catppuccin escapes
// ---------------------------------------------------------------------------

describe("buildThemedWidgetLines — themed path", () => {
  test("when piTheme is provided, output carries ANSI escape sequences", () => {
    const snap = makeSnap([makeRun("zzz", "themed-wf", "running")]);
    const lines = buildThemedWidgetLines(snap, NULL_PI_THEME, 120);
    assert.ok(lines.length >= 4, "themed render returns panel + entry lines");
    const joined = lines.join("");
    assert.ok(joined.includes("\x1b["), "themed lines include ANSI escapes");
  });

  test("awaiting-input title badge uses info blue and question mark", () => {
    const awaiting = makeRun("r1xxxxxx", "wf-await", "running", [
      makeStage("s1", "ask", "awaiting_input"),
    ]);
    const lines = buildThemedWidgetLines(makeSnap([awaiting]), NULL_PI_THEME, 160);
    const joined = lines.join("\n");
    const infoBlue = hexToAnsi(deriveGraphTheme({}).info);

    assert.ok(
      joined.includes(`${infoBlue}？ ↵ 1 needs attention`),
      "awaiting-input badge should be styled with the graph info blue",
    );
    assert.ok(
      stripAnsi(joined).includes("？ ↵ 1 needs attention (attach to workflow with `/workflow connect`)"),
      "awaiting-input badge should keep the status/question mark and attach copy",
    );
  });
});
