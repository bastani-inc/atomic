/**
 * Tests for overlay graph TUI module.
 */
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import type { Store } from "../../src/shared/store.js";
import type { StoreSnapshot, RunSnapshot, StageSnapshot } from "../../src/shared/store-types.js";
import { computeLayout, NODE_W } from "../../src/tui/layout.js";
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
    notices: [],
    version: 1,
  };
}

function makeStore(snap: StoreSnapshot): Store {
  return {
    runs: () => snap.runs as RunSnapshot[],
    notices: () => [],
    activeRunId: () => snap.runs[0]?.id ?? null,
    recordRunStart: () => {},
    recordStageStart: () => {},
    recordToolStart: () => {},
    recordToolEnd: () => {},
    recordStageEnd: () => {},
    recordStageAwaitingInput: () => false,
    recordRunEnd: () => false,
    recordNotice: () => {},
    ackNotice: () => false,
    recordPendingPrompt: () => false,
    resolvePendingPrompt: () => false,
    awaitPendingPrompt: () => Promise.reject(new Error("test stub")),
    recordStageSession: () => false,
    recordStageAttachable: () => false,
    recordStageAttached: () => false,
    recordStageBlocked: () => false,
    recordStageUnblocked: () => false,
    recordStageNotice: () => false,
    recordStagePaused: () => false,
    recordStageResumed: () => false,
    recordRunPaused: () => false,
    recordRunResumed: () => false,
    snapshot: () => snap,
    clear: () => {},
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
});

describe("fmtDuration", () => {
  it("0ms → 0s", () => {
    assert.equal(fmtDuration(0), "0s");
  });

  it("45000ms → 45s", () => {
    assert.equal(fmtDuration(45000), "45s");
  });

  it("84000ms → 1m24s", () => {
    assert.equal(fmtDuration(84000), "1m24s");
  });

  it("3h2m → 3h2m", () => {
    const ms = 3 * 3600000 + 2 * 60000;
    assert.equal(fmtDuration(ms), "3h2m");
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
    assert.equal(view._focusedIndex, 0);
    view.handleInput("j");
    assert.equal(view._focusedIndex, 1);
    view.handleInput("j");
    assert.equal(view._focusedIndex, 2);
    view.dispose();
  });

  it("k moves focus up", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["B"])];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    assert.equal(view._focusedIndex, 2);
    view.handleInput("k");
    assert.equal(view._focusedIndex, 1);
    view.dispose();
  });

  it("j does not go past last stage", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("k does not go below 0", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("k");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("ArrowDown (\\x1b[B) moves focus down", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    view.handleInput("\x1b[B");
    assert.equal(view._focusedIndex, 1);
    view.dispose();
  });

  it("ArrowUp (\\x1b[A) moves focus up", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("\x1b[A");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("ArrowRight (\\x1b[C) moves focus to next sibling at same depth", () => {
    // root → {B, C}: B and C are siblings at depth 1.
    const stages = [
      makeStage("root"),
      makeStage("B", ["root"]),
      makeStage("C", ["root"]),
    ];
    const view = makeView(stages);
    view.handleInput("\x1b[B"); // down into the sibling band (B)
    assert.equal(view._focusedIndex, 1);
    view.handleInput("\x1b[C"); // right → C
    assert.equal(view._focusedIndex, 2);
    view.dispose();
  });

  it("ArrowLeft (\\x1b[D) moves focus to previous sibling at same depth", () => {
    const stages = [
      makeStage("root"),
      makeStage("B", ["root"]),
      makeStage("C", ["root"]),
    ];
    const view = makeView(stages);
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[C"); // focus C
    view.handleInput("\x1b[D"); // left → B
    assert.equal(view._focusedIndex, 1);
    view.dispose();
  });

  it("ArrowRight clamps at the rightmost sibling", () => {
    const stages = [
      makeStage("root"),
      makeStage("B", ["root"]),
      makeStage("C", ["root"]),
    ];
    const view = makeView(stages);
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[C");
    view.handleInput("\x1b[C"); // already at C; should stay
    assert.equal(view._focusedIndex, 2);
    view.dispose();
  });

  it("gg (double g) jumps to first stage", () => {
    const stages = [makeStage("A"), makeStage("B"), makeStage("C")];
    const view = makeView(stages);
    view.handleInput("j");
    view.handleInput("j");
    assert.equal(view._focusedIndex, 2);
    // Simulate gg: two g presses within 500ms
    view.handleInput("g");
    view.handleInput("g");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("q calls onClose", () => {
    const stages = [makeStage("A")];
    const onClose = mock(() => {});
    const view = makeView(stages, onClose);
    view.handleInput("q");
    assert.equal(onClose.mock.calls.length, 1);
    view.dispose();
  });

  it("Escape calls onClose", () => {
    const stages = [makeStage("A")];
    const onClose = mock(() => {});
    const view = makeView(stages, onClose);
    view.handleInput("\x1b");
    assert.equal(onClose.mock.calls.length, 1);
    view.dispose();
  });

  it("/ opens switcher", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    assert.equal(view._switcherOpen, false);
    view.handleInput("/");
    assert.equal(view._switcherOpen, true);
    view.dispose();
  });

  it("Escape in switcher mode closes switcher", () => {
    const stages = [makeStage("A")];
    const view = makeView(stages);
    view.handleInput("/");
    assert.equal(view._switcherOpen, true);
    view.handleInput("\x1b");
    assert.equal(view._switcherOpen, false);
    view.dispose();
  });

  it("typing in switcher updates query", () => {
    const stages = [makeStage("A"), makeStage("B")];
    const view = makeView(stages);
    view.handleInput("/");
    view.handleInput("A");
    assert.equal(view._switcherState.query, "A");
    view.dispose();
  });

  it("Enter in switcher jumps to selected stage and closes switcher", () => {
    const stages = [makeStage("A"), makeStage("B"), makeStage("C")];
    const view = makeView(stages);
    view.handleInput("/");
    // ArrowDown to select index 1 (stage B)
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    assert.equal(view._switcherOpen, false);
    // focusedIndex should now correspond to B (index 1 in layout)
    assert.equal(view._focusedIndex, 1);
    view.dispose();
  });

  it("render returns lines in overlay mode", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const lines = view.render(80);
    assert.equal(Array.isArray(lines), true);
    assert.ok(lines.length > 0);
    view.dispose();
  });

  it("render shows orchestrator chrome and graph mode pill", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const text = view.render(96).join("\n");
    // Header pill carries the ORCHESTRATOR label in all caps.
    assert.match(text, /ORCHESTRATOR/);
    // Bottom statusline carries the GRAPH mode pill.
    assert.match(text, /GRAPH/);
    // Hints reflect the new vocabulary (navigate / attach / stages /
    // detach / quit) rather than the legacy j\/k focus row.
    assert.match(text, /navigate/);
    assert.match(text, /attach/);
    assert.match(text, /stages/);
    assert.match(text, /detach/);
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
    assert.equal(Array.isArray(lines), true);
    assert.ok(lines.length > 0);
    view.dispose();
  });

  it("renders the constant 32-line frame when no viewport provider is wired", () => {
    // Fallback path: direct unit renders without a host-provided
    // viewport accessor get the legacy OVERLAY_LINE_COUNT rectangle.
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const lines = view.render(96);
    assert.equal(lines.length, 32);
    view.dispose();
  });

  it("expands overlay to the reported viewport row count", () => {
    // Full-screen overlay path: when the host surfaces terminal.rows
    // through `getViewportRows`, the renderer must paint that many
    // lines so pi-tui anchors the popup as a full-frame overlay.
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 48,
    });
    const lines = view.render(96);
    assert.equal(lines.length, 48);
    view.dispose();
  });

  it("clamps to the constant minimum when reported viewport is smaller", () => {
    // Tiny terminals (or a host with stale row data) should never
    // drop below the 32-row minimum — the header/statusline budget
    // would otherwise underflow.
    const stages = [makeStage("A")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 10,
    });
    const lines = view.render(96);
    assert.equal(lines.length, 32);
    view.dispose();
  });

  it("empty-state overlay also fills the reported viewport rows", () => {
    // No active run — the empty welcome panel must respect the same
    // viewport-row contract so the full-screen overlay doesn't snap
    // to 32 rows when the user opens it before starting a workflow.
    const snap: StoreSnapshot = { runs: [], notices: [], version: 1 };
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: null,
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 42,
    });
    const lines = view.render(96);
    assert.equal(lines.length, 42);
    view.dispose();
  });
});

// ---------------------------------------------------------------------------
// GraphView animation timer
// ---------------------------------------------------------------------------

describe("GraphView animation timer", () => {
  it("fires requestRender on a steady cadence in overlay mode", async () => {
    const stages = [makeStage("A")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const requestRender = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      requestRender,
    });
    // Tick is 100ms; wait long enough for at least two ticks. Use real
    // timers — Bun's interval scheduler runs concurrently with the
    // test, so a small wall-clock wait is the simplest way to observe
    // the steady cadence without introducing a fake-timer dependency.
    await new Promise((r) => setTimeout(r, 250));
    view.dispose();
    assert.ok(
      requestRender.mock.calls.length >= 2,
      `expected ≥ 2 ticks in 250ms, got ${requestRender.mock.calls.length}`,
    );
  });

  it("does not start the timer in widget mode", async () => {
    const stages = [makeStage("A")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const requestRender = mock(() => {});
    const view = new GraphView({
      mode: "widget",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      requestRender,
    });
    await new Promise((r) => setTimeout(r, 250));
    view.dispose();
    assert.equal(requestRender.mock.calls.length, 0);
  });

  it("does not crash when requestRender is omitted in overlay mode", async () => {
    const stages = [makeStage("A")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
    });
    // No requestRender wired — the constructor must skip setInterval
    // entirely so callers that drive the view manually (legacy unit
    // tests, snapshot tooling) don't leak a dangling interval.
    await new Promise((r) => setTimeout(r, 150));
    view.dispose();
  });

  it("stops firing renders after dispose", async () => {
    const stages = [makeStage("A")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const requestRender = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      requestRender,
    });
    await new Promise((r) => setTimeout(r, 150));
    const beforeDispose = requestRender.mock.calls.length;
    view.dispose();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      requestRender.mock.calls.length,
      beforeDispose,
      "render must not be requested after dispose",
    );
  });

  it("running-stage border pulse advances with wall-clock time", () => {
    // The pulse phase is computed from `Date.now()` at render time, so
    // two renders at different timestamps must produce visibly
    // different ANSI for an unfocused running stage. The focused node
    // locks at the peak colour by design (see `pickBorder`), so we
    // need at least two nodes — focus stays on the first and the
    // second carries the animation we observe.
    const startedAt = Date.now() - 100;
    const stages: StageSnapshot[] = [
      { ...makeStage("A"), status: "running" as const, startedAt },
      { ...makeStage("B", ["A"]), status: "running" as const, startedAt },
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
    });
    const frameA = view.render(96).join("\n");
    // Wait long enough to land at a clearly different point in the
    // 2s pulse cycle (~25% of period). The sine eased lerp inside
    // `pickBorder` produces a visibly different RGB triple.
    const sleepUntil = Date.now() + 500;
    while (Date.now() < sleepUntil) {
      // busy-wait to advance Date.now() without yielding the event
      // loop; we want a synchronous render with a newer timestamp.
    }
    const frameB = view.render(96).join("\n");
    view.dispose();
    assert.notEqual(frameA, frameB, "pulse phase must change between renders");
  });
});
