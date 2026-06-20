// @ts-nocheck
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import * as h from "./overlay-graph-helpers.js";
import { computeLayout, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { buildConnector, buildMergeConnector } from "../../packages/workflows/src/tui/connectors.js";
import { statusColor, statusIcon, fmtDuration } from "../../packages/workflows/src/tui/status-helpers.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";
import { BOLD, RESET } from "../../packages/workflows/src/tui/color-utils.js";
import { Key } from "../../packages/workflows/src/tui/text-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
const { makeStage, makeSnap, makeRunPromptSnap, makePendingPrompt, makeAwaitingInputStage, makeInputRequest, makeStore, makeRun, defaultTheme, SGR_MOUSE_WHEEL_DOWN, visibleText, assertVisibleWidths, waitForRenderCount, typeIntoView, makeView } = h;

describe("computeLayout", () => {
  it("single node gets col=0, row=0", () => {
    const stages = [makeStage("A")];
    const nodes = computeLayout(stages);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.col, 0);
    assert.equal(nodes[0]!.row, 0);
    assert.equal(nodes[0]!.x, 0);
    assert.equal(nodes[0]!.y, 0);
  });

  it("empty input returns empty array", () => {
    assert.deepEqual(computeLayout([]), []);
  });

  it("linear chain A→B→C gets incrementing cols", () => {
    const stages = [
      makeStage("A"),
      makeStage("B", ["A"]),
      makeStage("C", ["B"]),
    ];
    const nodes = computeLayout(stages);
    const byId = new Map(nodes.map((n) => [n.stage.id, n]));
    assert.equal(byId.get("A")!.col, 0);
    assert.equal(byId.get("B")!.col, 1);
    assert.equal(byId.get("C")!.col, 2);
  });

  it("parallel branch root→[B,C]→D: B and C same col, D next col", () => {
    const stages = [
      makeStage("root"),
      makeStage("B", ["root"]),
      makeStage("C", ["root"]),
      makeStage("D", ["B", "C"]),
    ];
    const nodes = computeLayout(stages);
    const byId = new Map(nodes.map((n) => [n.stage.id, n]));
    assert.equal(byId.get("root")!.col, 0);
    assert.equal(byId.get("B")!.col, 1);
    assert.equal(byId.get("C")!.col, 1);
    // B and C should have different rows
    assert.notEqual(byId.get("B")!.row, byId.get("C")!.row);
    assert.equal(byId.get("D")!.col, 2);
  });

  it("x and y coordinates computed from colGap and rowGap", () => {
    const stages = [
      makeStage("A"),
      makeStage("B", ["A"]),
    ];
    const nodes = computeLayout(stages, { colGap: 4, rowGap: 2 });
    const byId = new Map(nodes.map((n) => [n.stage.id, n]));
    assert.equal(byId.get("A")!.x, 0);
    assert.equal(byId.get("B")!.x, NODE_W + 4);
  });
});

// ---------------------------------------------------------------------------
// Connector tests
// ---------------------------------------------------------------------------

describe("buildConnector", () => {
  it("returns dashes spanning fromX to toX", () => {
    const result = buildConnector(0, 5);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0]!.chars, "─────");
  });

  it("works with reversed order (toX < fromX)", () => {
    const result = buildConnector(5, 0);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0]!.chars, "─────");
  });

  it("returns empty when fromX === toX", () => {
    const result = buildConnector(3, 3);
    assert.equal(result.lines[0]!.chars, "");
  });
});

describe("buildMergeConnector", () => {
  it("single source behaves like buildConnector", () => {
    const result = buildMergeConnector([0], 5);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0]!.chars, "─────");
  });

  it("two sources produce multi-line fan-in", () => {
    const result = buildMergeConnector([0, 4], 2);
    // Should have 3 lines: top, mid, bottom
    assert.ok(result.lines.length >= 2);
    // Top line should contain ┬ at source positions
    const topLine = result.lines[0]!.chars;
    assert.ok(topLine.includes("┬"));
  });

  it("returns empty for empty sources", () => {
    const result = buildMergeConnector([], 5);
    assert.equal(result.lines.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Status helpers tests
// ---------------------------------------------------------------------------

describe("statusColor", () => {
  it("pending → theme.dim", () => {
    assert.equal(statusColor("pending", defaultTheme), defaultTheme.dim);
  });

  it("running → theme.warning", () => {
    assert.equal(statusColor("running", defaultTheme), defaultTheme.warning);
  });

  it("paused → theme.warning", () => {
    assert.equal(statusColor("paused", defaultTheme), defaultTheme.warning);
  });

  it("completed → theme.success", () => {
    assert.equal(statusColor("completed", defaultTheme), defaultTheme.success);
  });

  it("failed → theme.error", () => {
    assert.equal(statusColor("failed", defaultTheme), defaultTheme.error);
  });

  it("killed → theme.error", () => {
    assert.equal(statusColor("killed", defaultTheme), defaultTheme.error);
  });
});

describe("statusIcon", () => {
  it("pending → ○", () => {
    assert.equal(statusIcon("pending"), "○");
  });

  it("running → ●", () => {
    assert.equal(statusIcon("running"), "●");
  });

  it("completed → ✓", () => {
    assert.equal(statusIcon("completed"), "✓");
  });

  it("failed → ✗", () => {
    assert.equal(statusIcon("failed"), "✗");
  });

  it("killed → ⊘", () => {
    assert.equal(statusIcon("killed"), "⊘");
  });

  it("paused → ❚❚", () => {
    assert.equal(statusIcon("paused"), "❚❚");
  });
});

describe("fmtDuration", () => {
  it("0ms → 0s", () => {
    assert.equal(fmtDuration(0), "0s");
  });

  it("45000ms → 45s", () => {
    assert.equal(fmtDuration(45000), "45s");
  });

  it("84000ms → 1m 24s", () => {
    assert.equal(fmtDuration(84000), "1m 24s");
  });

  it("3h2m → 3h 2m", () => {
    const ms = 3 * 3600000 + 2 * 60000;
    assert.equal(fmtDuration(ms), "3h 2m");
  });

  it("60s → 1m", () => {
    assert.equal(fmtDuration(60000), "1m");
  });

  it("3600000ms → 1h", () => {
    assert.equal(fmtDuration(3600000), "1h");
  });
});

// ---------------------------------------------------------------------------
// GraphView keyboard tests
// ---------------------------------------------------------------------------

