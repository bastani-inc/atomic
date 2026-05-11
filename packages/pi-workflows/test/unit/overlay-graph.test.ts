/**
 * Tests for overlay graph TUI module.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Store } from "../../src/store.js";
import type { StoreSnapshot, RunSnapshot, StageSnapshot } from "../../src/store-types.js";
import { computeLayout, NODE_W, NODE_H } from "../../src/tui/layout.js";
import { buildConnector, buildMergeConnector } from "../../src/tui/connectors.js";
import { statusColor, statusIcon, fmtDuration } from "../../src/tui/status-helpers.js";
import { GraphView } from "../../src/tui/graph-view.js";
import { deriveGraphTheme } from "../../src/tui/graph-theme.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeStage(id: string, parentIds: string[] = []): StageSnapshot {
  return {
    id,
    name: id,
    status: "pending",
    parentIds,
    toolEvents: [],
  };
}

function makeRun(stages: StageSnapshot[]): RunSnapshot {
  return {
    id: "run-1",
    name: "Test Run",
    inputs: {},
    status: "running",
    stages,
    startedAt: Date.now(),
  };
}

function makeSnap(stages: StageSnapshot[]): StoreSnapshot {
  return {
    runs: [makeRun(stages)],
    version: 1,
  };
}

function makeStore(snap: StoreSnapshot): Store {
  return {
    runs: () => snap.runs as RunSnapshot[],
    activeRunId: () => snap.runs[0]?.id ?? null,
    recordRunStart: () => {},
    recordStageStart: () => {},
    recordToolStart: () => {},
    recordToolEnd: () => {},
    recordStageEnd: () => {},
    recordRunEnd: () => {},
    snapshot: () => snap,
    subscribe: () => () => {},
  };
}

const defaultTheme = deriveGraphTheme({});

// ---------------------------------------------------------------------------
// Layout tests
// ---------------------------------------------------------------------------

describe("computeLayout", () => {
  it("single node gets col=0, row=0", () => {
    const stages = [makeStage("A")];
    const nodes = computeLayout(stages);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.col).toBe(0);
    expect(nodes[0]!.row).toBe(0);
    expect(nodes[0]!.x).toBe(0);
    expect(nodes[0]!.y).toBe(0);
  });

  it("empty input returns empty array", () => {
    expect(computeLayout([])).toEqual([]);
  });

  it("linear chain A→B→C gets incrementing cols", () => {
    const stages = [
      makeStage("A"),
      makeStage("B", ["A"]),
      makeStage("C", ["B"]),
    ];
    const nodes = computeLayout(stages);
    const byId = new Map(nodes.map((n) => [n.stage.id, n]));
    expect(byId.get("A")!.col).toBe(0);
    expect(byId.get("B")!.col).toBe(1);
    expect(byId.get("C")!.col).toBe(2);
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
    expect(byId.get("root")!.col).toBe(0);
    expect(byId.get("B")!.col).toBe(1);
    expect(byId.get("C")!.col).toBe(1);
    // B and C should have different rows
    expect(byId.get("B")!.row).not.toBe(byId.get("C")!.row);
    expect(byId.get("D")!.col).toBe(2);
  });

  it("x and y coordinates computed from colGap and rowGap", () => {
    const stages = [
      makeStage("A"),
      makeStage("B", ["A"]),
    ];
    const nodes = computeLayout(stages, { colGap: 4, rowGap: 2 });
    const byId = new Map(nodes.map((n) => [n.stage.id, n]));
    expect(byId.get("A")!.x).toBe(0);
    expect(byId.get("B")!.x).toBe(NODE_W + 4);
  });
});

// ---------------------------------------------------------------------------
// Connector tests
// ---------------------------------------------------------------------------

describe("buildConnector", () => {
  it("returns dashes spanning fromX to toX", () => {
    const result = buildConnector(0, 5);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.chars).toBe("─────");
  });

  it("works with reversed order (toX < fromX)", () => {
    const result = buildConnector(5, 0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.chars).toBe("─────");
  });

  it("returns empty when fromX === toX", () => {
    const result = buildConnector(3, 3);
    expect(result.lines[0]!.chars).toBe("");
  });
});

describe("buildMergeConnector", () => {
  it("single source behaves like buildConnector", () => {
    const result = buildMergeConnector([0], 5);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.chars).toBe("─────");
  });

  it("two sources produce multi-line fan-in", () => {
    const result = buildMergeConnector([0, 4], 2);
    // Should have 3 lines: top, mid, bottom
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    // Top line should contain ┬ at source positions
    const topLine = result.lines[0]!.chars;
    expect(topLine).toContain("┬");
  });

  it("returns empty for empty sources", () => {
    const result = buildMergeConnector([], 5);
    expect(result.lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status helpers tests
// ---------------------------------------------------------------------------

describe("statusColor", () => {
  it("pending → #888888", () => {
    expect(statusColor("pending")).toBe("#888888");
  });

  it("running → #4fc3f7", () => {
    expect(statusColor("running")).toBe("#4fc3f7");
  });

  it("completed → #66bb6a", () => {
    expect(statusColor("completed")).toBe("#66bb6a");
  });

  it("failed → #ef5350", () => {
    expect(statusColor("failed")).toBe("#ef5350");
  });

  it("killed → #ff9800", () => {
    expect(statusColor("killed")).toBe("#ff9800");
  });
});

describe("statusIcon", () => {
  it("pending → ○", () => {
    expect(statusIcon("pending")).toBe("○");
  });

  it("running → ◉", () => {
    expect(statusIcon("running")).toBe("◉");
  });

  it("completed → ✓", () => {
    expect(statusIcon("completed")).toBe("✓");
  });

  it("failed → ✗", () => {
    expect(statusIcon("failed")).toBe("✗");
  });

  it("killed → ⊘", () => {
    expect(statusIcon("killed")).toBe("⊘");
  });
});

describe("fmtDuration", () => {
  it("0ms → 0s", () => {
    expect(fmtDuration(0)).toBe("0s");
  });

  it("45000ms → 45s", () => {
    expect(fmtDuration(45000)).toBe("45s");
  });

  it("84000ms → 1m24s", () => {
    expect(fmtDuration(84000)).toBe("1m24s");
  });

  it("3h2m → 3h2m", () => {
    const ms = 3 * 3600000 + 2 * 60000;
    expect(fmtDuration(ms)).toBe("3h2m");
  });

  it("60s → 1m", () => {
    expect(fmtDuration(60000)).toBe("1m");
  });

  it("3600000ms → 1h", () => {
    expect(fmtDuration(3600000)).toBe("1h");
  });
});

// ---------------------------------------------------------------------------
// GraphView keyboard tests
// ---------------------------------------------------------------------------

describe("GraphView keyboard navigation", () => {
  function makeView(stages: StageSnapshot[], onClose?: () => void) {
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onClose,
    });
    return view;
  }

  it("j moves focus down", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["B"])];
    const view = makeView(stages);
    expect(view._focusedIndex).toBe(0);
    view.handleInput("j");
    expect(view._focusedIndex).toBe(1);
    view.handleInput("j");
    expect(view._focusedIndex).toBe(2);
    view.dispose();
  });

  it("k moves focus up", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["B"])];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    expect(view._focusedIndex).toBe(2);
    view.handleInput("k");
    expect(view._focusedIndex).toBe(1);
    view.dispose();
  });

  it("j does not go past last stage", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    expect(view._focusedIndex).toBe(0);
    view.dispose();
  });

  it("k does not go below 0", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("k");
    expect(view._focusedIndex).toBe(0);
    view.dispose();
  });

  it("ArrowDown (\\x1b[B) moves focus down", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("\x1b[B");
    expect(view._focusedIndex).toBe(1);
    view.dispose();
  });

  it("ArrowUp (\\x1b[A) moves focus up", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("\x1b[A");
    expect(view._focusedIndex).toBe(0);
    view.dispose();
  });

  it("gg (double g) jumps to first stage", () => {
    const stages = [makeStage("A"), makeStage("B"), makeStage("C")];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    expect(view._focusedIndex).toBe(2);
    // Simulate gg: two g presses within 500ms
    view.handleInput("g");
    view.handleInput("g");
    expect(view._focusedIndex).toBe(0);
    view.dispose();
  });

  it("q calls onClose", () => {
    const stages = [makeStage("A")];
    const onClose = mock(() => {});
    const view = makeView(stages, onClose);
    view.handleInput("q");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("Escape calls onClose", () => {
    const stages = [makeStage("A")];
    const onClose = mock(() => {});
    const view = makeView(stages, onClose);
    view.handleInput("\x1b");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("/ opens switcher", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    expect(view._switcherOpen).toBe(false);
    view.handleInput("/");
    expect(view._switcherOpen).toBe(true);
    view.dispose();
  });

  it("Escape in switcher mode closes switcher", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    view.handleInput("/");
    expect(view._switcherOpen).toBe(true);
    view.handleInput("\x1b");
    expect(view._switcherOpen).toBe(false);
    view.dispose();
  });

  it("typing in switcher updates query", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("/");
    view.handleInput("A");
    expect(view._switcherState.query).toBe("A");
    view.dispose();
  });

  it("Enter in switcher jumps to selected stage and closes switcher", () => {
    const stages = [makeStage("A"), makeStage("B"), makeStage("C")];
    const view = makeView(stages);
    view.handleInput("/");
    // ArrowDown to select index 1 (stage B)
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(view._switcherOpen).toBe(false);
    // focusedIndex should now correspond to B (index 1 in layout)
    expect(view._focusedIndex).toBe(1);
    view.dispose();
  });

  it("render returns lines in overlay mode", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const lines = view.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    view.dispose();
  });

  it("render returns lines in widget mode", () => {
    const snap = makeSnap([makeStage("A")]);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "widget",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
    });
    const lines = view.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    view.dispose();
  });
});
