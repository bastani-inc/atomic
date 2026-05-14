/**
 * Unit tests for the rounded node-card renderer.
 *
 * Pinned behaviours (DESIGN.md §5):
 *  - Fixed geometry: width × height regardless of focus or status.
 *  - Status border colour: completed = success, failed = error,
 *    running = warning (locked at peak when focused), pending =
 *    borderDim (lifted to borderActive when focused).
 *  - Focus signal: the centred title turns into an accent-coloured
 *    "tab" (`▸ name`) painted with `theme.accent` bg + `theme.surface`
 *    fg + bold. The non-focused title is bold-on-card-bg.
 *
 * cross-ref:
 *   - src/tui/node-card.ts
 *   - src/tui/graph-theme.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { StageSnapshot, StageStatus } from "../../src/shared/store-types.js";
import { renderNodeCard } from "../../src/tui/node-card.js";
import { deriveGraphTheme } from "../../src/tui/graph-theme.js";
import { hexBg, hexToAnsi } from "../../src/tui/color-utils.js";
import { NODE_W, NODE_H } from "../../src/tui/layout.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const theme = deriveGraphTheme({});

function makeStage(opts: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: opts.id ?? "alpha",
    name: opts.name ?? "alpha",
    status: opts.status ?? ("pending" as StageStatus),
    parentIds: opts.parentIds ?? [],
    toolEvents: opts.toolEvents ?? [],
    durationMs: opts.durationMs,
    startedAt: opts.startedAt,
    blockedByStageId: opts.blockedByStageId,
  };
}

describe("renderNodeCard — geometry", () => {
  test("emits exactly NODE_H lines at NODE_W cells wide", () => {
    const lines = renderNodeCard(makeStage(), { theme });
    assert.equal(lines.length, NODE_H);
    for (const line of lines) {
      // Visible width is `NODE_W` for every row.
      assert.equal(stripAnsi(line).length, NODE_W);
    }
  });

  test("focus does not change card dimensions", () => {
    const unfocused = renderNodeCard(makeStage({ name: "deploy" }), {
      theme,
      focused: false,
    });
    const focused = renderNodeCard(makeStage({ name: "deploy" }), {
      theme,
      focused: true,
    });
    assert.equal(focused.length, unfocused.length);
    for (let i = 0; i < focused.length; i++) {
      assert.equal(
        stripAnsi(focused[i]!).length,
        stripAnsi(unfocused[i]!).length,
        `row ${i} width must stay constant between focused/unfocused`,
      );
    }
  });
});

describe("renderNodeCard — focused tab marker", () => {
  test("focused card includes the ▸ glyph in the title slot", () => {
    const lines = renderNodeCard(makeStage({ name: "deploy" }), {
      theme,
      focused: true,
    });
    const top = stripAnsi(lines[0]!);
    assert.match(top, /▸ deploy/);
  });

  test("unfocused card omits the focus glyph", () => {
    const lines = renderNodeCard(makeStage({ name: "deploy" }), {
      theme,
      focused: false,
    });
    const top = stripAnsi(lines[0]!);
    assert.doesNotMatch(top, /▸/);
    // Stage name still appears in the title slot.
    assert.match(top, /deploy/);
  });

  test("focused tab paints the accent background on the title slot", () => {
    const lines = renderNodeCard(makeStage({ name: "ship" }), {
      theme,
      focused: true,
    });
    // The accent bg SGR sequence sourced from `theme.accent` must
    // appear somewhere on the top border — that's the tab.
    const accentBg = hexBg(theme.accent);
    assert.ok(
      lines[0]!.includes(accentBg),
      `focused top row must include accent bg SGR ${JSON.stringify(accentBg)}`,
    );
  });

  test("unfocused card never paints the accent background", () => {
    const lines = renderNodeCard(makeStage({ name: "ship" }), {
      theme,
      focused: false,
    });
    const accentBg = hexBg(theme.accent);
    for (const line of lines) {
      assert.ok(
        !line.includes(accentBg),
        "unfocused card must not include accent bg SGR anywhere",
      );
    }
  });
});

describe("renderNodeCard — status border colours", () => {
  function topRowAnsiSequences(line: string): string[] {
    return line.match(ANSI_RE) ?? [];
  }

  test("completed status uses the success border colour", () => {
    const lines = renderNodeCard(
      makeStage({ status: "completed", durationMs: 1200 }),
      { theme },
    );
    const successFg = hexToAnsi(theme.success);
    assert.ok(
      lines[0]!.includes(successFg),
      "top border must include success fg SGR for completed status",
    );
  });

  test("failed status uses the error border colour", () => {
    const lines = renderNodeCard(
      makeStage({ status: "failed", durationMs: 800 }),
      { theme },
    );
    const errorFg = hexToAnsi(theme.error);
    assert.ok(
      lines[0]!.includes(errorFg),
      "top border must include error fg SGR for failed status",
    );
  });

  test("focused running stage locks the border to warning (not pulsing lerp)", () => {
    const lines = renderNodeCard(
      makeStage({ status: "running", startedAt: Date.now() - 500 }),
      { theme, focused: true, pulsePhase: 0 /* trough of the lerp */ },
    );
    const warningFg = hexToAnsi(theme.warning);
    assert.ok(
      lines[0]!.includes(warningFg),
      "focused running border must lock at warning regardless of pulse phase",
    );
  });

  test("awaiting_input status uses info border and response hint copy", () => {
    const lines = renderNodeCard(
      makeStage({ status: "awaiting_input", startedAt: Date.now() - 1000 }),
      { theme, focused: true },
    );
    const infoFg = hexToAnsi(theme.info);
    assert.ok(
      lines[0]!.includes(infoFg),
      "awaiting input border must use info token",
    );
    const rendered = stripAnsi(lines.join("\n"));
    assert.match(rendered, /waiting for response/);
    assert.match(rendered, /↵ enter to respond/);
  });

  test("focused pending stage lifts to borderActive (not text)", () => {
    const lines = renderNodeCard(makeStage({ status: "pending" }), {
      theme,
      focused: true,
    });
    const borderActiveFg = hexToAnsi(theme.borderActive);
    assert.ok(
      lines[0]!.includes(borderActiveFg),
      "focused pending border must use borderActive token",
    );
    // The previous behaviour used `theme.text` as the border colour;
    // make sure we didn't regress to that even though the tab still
    // uses bold + accent bg.
    const sequencesOnTop = topRowAnsiSequences(lines[0]!);
    const textFg = hexToAnsi(theme.text);
    // text may legitimately appear if accent bg is missing, so this
    // assertion only fires when neither accent bg nor borderActive
    // is doing the focus work — should never happen.
    if (!lines[0]!.includes(hexBg(theme.accent))) {
      assert.ok(
        !sequencesOnTop.includes(textFg),
        "fallback path must not use theme.text as border colour",
      );
    }
  });

  test("blocked status uses dim border and renders cascade badge", () => {
    const lines = renderNodeCard(
      makeStage({ status: "blocked", blockedByStageId: "review-a" }),
      {
        theme,
        stages: [makeStage({ id: "review-a", name: "review-a" })],
      },
    );
    const dimFg = hexToAnsi(theme.dim);
    assert.ok(
      lines[0]!.includes(dimFg),
      "blocked border must use dim warning tint",
    );
    assert.match(stripAnsi(lines[1]!), /↑ blocked by review-a/);
  });

  test("blocked badge drops upstream first when the card is narrow", () => {
    const lines = renderNodeCard(
      makeStage({
        status: "blocked",
        blockedByStageId: "very-long-upstream-stage",
      }),
      {
        theme,
        width: 12,
        stages: [
          makeStage({
            id: "very-long-upstream-stage",
            name: "very-long-upstream-stage",
          }),
        ],
      },
    );
    const row = stripAnsi(lines[1]!);
    assert.match(row, /↑ blocked/);
    assert.doesNotMatch(row, /very-long-upstream-stage/);
  });
});

describe("renderNodeCard — duration line", () => {
  test("emits an em-dash when the stage has no timing data", () => {
    const lines = renderNodeCard(makeStage({ status: "pending" }), { theme });
    const body = stripAnsi(lines[1]!);
    assert.match(body, /—/);
  });

  test("renders fmtDuration output when durationMs is present", () => {
    const lines = renderNodeCard(
      makeStage({ status: "completed", durationMs: 65_000 }),
      { theme },
    );
    const body = stripAnsi(lines[1]!);
    // fmtDuration(65000) → "1m5s" (per status-helpers.ts).
    assert.match(body, /1m5s/);
  });
});
