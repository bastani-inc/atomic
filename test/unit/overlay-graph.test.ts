/**
 * Tests for overlay graph TUI module.
 */
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type {
  PendingPrompt,
  StageInputRequest,
  StoreSnapshot,
  RunSnapshot,
  StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { computeLayout, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { buildConnector, buildMergeConnector } from "../../packages/workflows/src/tui/connectors.js";
import { statusColor, statusIcon, fmtDuration } from "../../packages/workflows/src/tui/status-helpers.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";
import { BOLD, RESET } from "../../packages/workflows/src/tui/color-utils.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

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

function makePendingPrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: "prompt-1",
    kind: "input",
    message: "Continue?",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeInputRequest(overrides: Partial<StageInputRequest> = {}): StageInputRequest {
  return {
    id: "input-request-1",
    kind: "ask_user_question",
    createdAt: Date.now(),
    questions: [
      {
        question: "Which option should the workflow use?",
        header: "Choice",
        options: [{ label: "Use A" }, { label: "Use B" }],
      },
    ],
    ...overrides,
  };
}

function makeAwaitingInputStage(
  id: string,
  parentIds: string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    ...makeStage(id, parentIds),
    status: "awaiting_input",
    awaitingInputSince: Date.now(),
    attachable: true,
    ...overrides,
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

function makeRunPromptSnap(
  stages: StageSnapshot[],
  prompt: PendingPrompt,
): StoreSnapshot {
  return {
    runs: [{ ...makeRun(stages), pendingPrompt: prompt }],
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
    recordStageInputRequest: () => false,
    clearStageInputRequest: () => false,
    recordRunEnd: () => false,
    removeRun: () => false,
    recordNotice: () => {},
    ackNotice: () => false,
    recordPendingPrompt: () => false,
    resolvePendingPrompt: () => false,
    awaitPendingPrompt: () => Promise.reject(new Error("test stub")),
    recordStagePendingPrompt: () => false,
    resolveStagePendingPrompt: () => false,
    awaitStagePendingPrompt: () => Promise.reject(new Error("test stub")),
    getStagePromptAnswer: () => undefined,
    clearStagePromptAnswer: () => {},
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
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SGR_MOUSE_WHEEL_DOWN = "\x1b[<65;10;10M";

function visibleText(lines: string[]): string {
  return lines.join("\n").replace(ANSI_RE, "");
}

function assertVisibleWidths(lines: string[], width: number): void {
  for (const [idx, line] of lines.entries()) {
    assert.equal(
      visibleWidth(line),
      width,
      `line ${idx} expected visible width ${width}, got ${visibleWidth(line)}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRenderCount(
  count: () => number,
  target: number,
  polls = 80,
  pollMs = 25,
): Promise<void> {
  for (let i = 0; i < polls && count() < target; i++) {
    await delay(pollMs);
  }
}

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

  it("Escape variants and Ctrl+C variants call onClose", () => {
    const stages = [makeStage("A")];
    const onClose = mock(() => {});
    const view = makeView(stages, onClose);
    const closeKeys = [
      "\x1b",
      "\x1b[27u",
      "\x1b[27;1;27~",
      "\x03",
      "\x1b[99;5u",
      "\x1b[99;5:1u",
      "\x1b[27;5;99~",
    ];
    for (const key of closeKeys) {
      view.handleInput(key);
    }
    assert.equal(onClose.mock.calls.length, closeKeys.length);
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

  it("Enter in switcher attaches the selected stage when chat attach is available", () => {
    const stages = [makeStage("A"), makeStage("B"), makeStage("C")];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const onStageAttach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onStageAttach,
    });

    view.handleInput("/");
    // ArrowDown to select index 1 (stage B), then Enter should open
    // B's chat directly instead of leaving the user on the graph node.
    view.handleInput("\x1b[B");
    view.handleInput("\r");

    assert.equal(view._switcherOpen, false);
    assert.equal(view._focusedIndex, 1);
    assert.equal(onStageAttach.mock.calls.length, 1);
    assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "B"]);
    view.dispose();
  });

  it("switcher renders as an opaque panel without leaking graph cells through its rows", () => {
    const stages = [
      makeStage("root"),
      makeStage("branch-left", ["root"]),
      makeStage("branch-right", ["root"]),
      makeStage("merge", ["branch-left", "branch-right"]),
      makeStage("tail-a", ["merge"]),
      makeStage("tail-b", ["tail-a"]),
    ];
    const view = makeView(stages);

    assert.match(visibleText(view.render(200)), /╭──── branch-right/);
    view.handleInput("/");
    const withSwitcher = visibleText(view.render(200));
    assert.match(withSwitcher, /STAGES/);
    assert.match(withSwitcher, /│\s+○ root\s+pending\s+│/);
    assert.doesNotMatch(withSwitcher, /^│ ▸/m);
    assert.doesNotMatch(withSwitcher, /╭──── branch-right/);
    assert.doesNotMatch(withSwitcher, /╭─────── merge ────────╮/);
    view.dispose();
  });

  it("preserves visible gutters between sibling node cards", () => {
    const stages = [
      makeStage("root"),
      makeStage("branch-left", ["root"]),
      makeStage("branch-right", ["root"]),
    ];
    const view = makeView(stages);
    const text = visibleText(view.render(140));

    assert.doesNotMatch(text, /╮╭/);
    assert.doesNotMatch(text, /╯╰/);
    assert.match(text, /╮ {4,}╭/);
    view.dispose();
  });

  it("renders switcher with rounded-only panel border chrome", () => {
    const stages = [makeStage("root"), makeStage("worker", ["root"])];
    const text = visibleText(
      renderSwitcher(stages, { query: "", selectedIndex: 0 }, {
        width: 48,
        theme: defaultTheme,
      }),
    );

    assert.match(text, /╭─+╮/);
    assert.match(text, /╰─+╯/);
    assert.doesNotMatch(text, /[\u251c\u2524\u250c\u2510\u2514\u2518+]/);
  });

  it("renders switcher rows to the configured width across selection and empty states", () => {
    const stages = [
      makeStage("root"),
      makeStage("branch-with-a-very-long-name-that-should-truncate", ["root"]),
      { ...makeStage("done", ["root"]), status: "completed" as const },
    ];
    const width = 56;
    assertVisibleWidths(
      renderSwitcher(stages, { query: "", selectedIndex: 0 }, {
        width,
        theme: defaultTheme,
      }),
      width,
    );
    assertVisibleWidths(
      renderSwitcher(stages, {
        query: "this-query-is-far-too-long-to-fit-inside-the-panel",
        selectedIndex: 0,
      }, {
        width,
        theme: defaultTheme,
      }),
      width,
    );
  });

  it("keeps selected switcher row styling active through truncated names", () => {
    const stages = [makeStage("branch-with-a-very-long-name-that-should-truncate")];
    const width = 40;
    const lines = renderSwitcher(stages, { query: "", selectedIndex: 0 }, {
      width,
      theme: defaultTheme,
    });
    const selectedRow = lines[3]!;
    const selectedText = visibleText([selectedRow]);

    assert.equal(visibleWidth(selectedRow), width);
    assert.match(selectedText, /branch-with-a-very-long-…/);

    const boldIndex = selectedRow.indexOf(BOLD);
    const ellipsisIndex = selectedRow.indexOf("…", boldIndex);
    const firstResetAfterBold = selectedRow.indexOf(RESET, boldIndex + BOLD.length);

    assert.notEqual(boldIndex, -1);
    assert.notEqual(ellipsisIndex, -1);
    assert.ok(
      firstResetAfterBold > ellipsisIndex,
      "selected row should not reset ANSI styling before the truncation ellipsis",
    );
  });

  it("does not add ellipsis to non-truncated selected switcher rows", () => {
    const stages = [makeStage("short")];
    const width = 40;
    const lines = renderSwitcher(stages, { query: "", selectedIndex: 0 }, {
      width,
      theme: defaultTheme,
    });
    const selectedText = visibleText([lines[3]!]);

    assert.doesNotMatch(selectedText, /…/);
    assert.match(selectedText, /│  ○ short\s+pending │/);
  });

  it("renders the switcher as a focused modal body for long workflows", () => {
    const stages = Array.from({ length: 16 }, (_, i) =>
      makeStage(`stage-${i}`, i === 0 ? [] : [`stage-${i - 1}`]),
    );
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 40,
    });

    view.handleInput("/");
    const withSwitcher = visibleText(view.render(160));
    assert.match(withSwitcher, /STAGES/);
    assert.match(withSwitcher, /│\s+○ stage-0\s+pending\s+│/);
    assert.doesNotMatch(withSwitcher, /╭.*stage-0/);
    assert.doesNotMatch(withSwitcher, /^\s*○ stage-0\s+pending/m);
    view.dispose();
  });

  it("horizontally scrolls wide fan-out graphs instead of switching to a compact list", () => {
    const stages = [
      makeStage("root"),
      makeStage("child-0", ["root"]),
      makeStage("child-1", ["root"]),
      makeStage("child-2", ["root"]),
      makeStage("child-3", ["root"]),
      makeStage("child-4", ["root"]),
      makeStage("child-5", ["root"]),
    ];
    const view = makeView(stages);

    assert.doesNotMatch(visibleText(view.render(80)), /╭.*child-5/);
    view.handleInput("\x1b[B");
    for (let i = 0; i < 5; i++) view.handleInput("\x1b[C");
    const afterNav = visibleText(view.render(80));
    assert.match(afterNav, /╭.*child-5/);
    assert.doesNotMatch(afterNav, /^\s*○ child-5\s+pending/m);
    view.dispose();
  });

  it("Ctrl+D variants detach in overlay graph mode", () => {
    const ctrlDVariants = [
      "\x04",
      "\x1b[100;5u",
      "\x1b[100;5:1u",
      "\x1b[27;5;100~",
    ];

    for (const key of ctrlDVariants) {
      const snap = makeSnap([makeStage("A")]);
      const store = makeStore(snap);
      let detached = 0;
      const view = new GraphView({
        mode: "overlay",
        runId: "run-1",
        store,
        graphTheme: defaultTheme,
        onDetach: () => {
          detached += 1;
        },
      });
      view.handleInput(key);
      assert.equal(detached, 1, JSON.stringify(key));
      view.dispose();
    }
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

  it("leaves unpainted top and bottom margin rows around the orchestrator panel", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const lines = view.render(96);
    assert.equal(lines.length, 32);
    assert.equal(lines[0], " ".repeat(96));
    assert.equal(lines.at(-1), " ".repeat(96));
    assert.match(visibleText(lines.slice(1, 4)), /ORCHESTRATOR/);
    assert.match(visibleText(lines.slice(-4, -1)), /GRAPH/);
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

  it("respects short reported viewport rows and keeps status controls visible", () => {
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
    assert.equal(lines.length, 10);
    assert.match(visibleText(lines.slice(-4)), /GRAPH/);
    view.dispose();
  });

  it("hides unstarted placeholder stages while a prompt stage is awaiting input", () => {
    const stages = [
      makeStage("capture"),
      {
        ...makeStage("input"),
        status: "awaiting_input" as const,
        startedAt: Date.now() - 1000,
        awaitingInputSince: Date.now() - 1000,
        attachable: true,
        pendingPrompt: {
          id: "prompt-1",
          kind: "input" as const,
          message: "Favorite color?",
          createdAt: Date.now() - 1000,
        },
      },
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
    });

    const rendered = visibleText(view.render(96));
    assert.doesNotMatch(rendered, /capture/);
    assert.match(rendered, /input/);
    assert.match(rendered, /waiting for response/);
    view.dispose();
  });

  it("renders stage-local pending prompts as graph nodes without the global prompt overlay", () => {
    const stages = [{
      ...makeStage("input"),
      status: "awaiting_input" as const,
      startedAt: Date.now() - 1000,
      awaitingInputSince: Date.now() - 1000,
      attachable: true,
      pendingPrompt: {
        id: "prompt-1",
        kind: "input" as const,
        message: "Your name?",
        createdAt: Date.now() - 1000,
      },
    }];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const onStageAttach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach,
    });

    const rendered = visibleText(view.render(96));
    assert.doesNotMatch(rendered, /AWAITING INPUT/);
    assert.match(rendered, /waiting for response/);
    assert.match(rendered, /enter to respond/);
    view.handleInput("\r");
    assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "input"]);
    view.dispose();
  });

  it("auto-focuses a newly awaiting stage prompt node so Enter attaches to the HIL UI", () => {
    const store = createStore();
    store.recordRunStart({
      id: "run-1",
      name: "Test Run",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    store.recordStageStart("run-1", {
      id: "search-candidates",
      name: "search-candidates",
      status: "completed",
      parentIds: [],
      toolEvents: [],
    });
    const onStageAttach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach,
    });
    assert.equal(view._focusedIndex, 0);

    store.recordStageStart("run-1", {
      id: "editor-stage",
      name: "editor",
      status: "running",
      parentIds: ["search-candidates"],
      toolEvents: [],
      attachable: true,
    });
    store.recordStagePendingPrompt("run-1", "editor-stage", {
      id: "prompt-editor-1",
      kind: "editor",
      message: "Edit and save to continue.",
      initial: "approval json",
      createdAt: Date.now(),
    });

    assert.equal(view._focusedIndex, 1);
    view.handleInput("\r");
    assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "editor-stage"]);
    view.dispose();
  });

  it("keeps graph navigation live while a stage-local pendingPrompt is awaiting input", () => {
    const stages = [
      { ...makeStage("done"), status: "completed" as const },
      makeAwaitingInputStage("input", ["done"], {
        pendingPrompt: makePendingPrompt(),
      }),
    ];
    const view = makeView(stages);

    assert.equal(view._focusedIndex, 1);
    view.handleInput("\x1b[A");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("keeps graph navigation live while a stage-local inputRequest is awaiting input", () => {
    const stages = [
      { ...makeStage("done"), status: "completed" as const },
      makeAwaitingInputStage("question", ["done"], {
        inputRequest: makeInputRequest(),
      }),
    ];
    const view = makeView(stages);

    assert.equal(view._focusedIndex, 1);
    view.handleInput("\x1b[A");
    assert.equal(view._focusedIndex, 0);
    view.dispose();
  });

  it("keeps graph shell controls live while a stage-local HIL request is active", () => {
    const stages = [
      { ...makeStage("done"), status: "completed" as const },
      makeAwaitingInputStage("question", ["done"], {
        inputRequest: makeInputRequest(),
      }),
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const onStageAttach = mock(() => {});
    let detached = 0;
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onStageAttach,
      onDetach: () => {
        detached += 1;
      },
    });

    view.handleInput("/");
    assert.equal(view._switcherOpen, true);
    view.handleInput("\x1b");
    assert.equal(view._switcherOpen, false);

    view.handleInput("\r");
    assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "question"]);

    view.handleInput("\x04");
    assert.equal(detached, 1);
    view.dispose();
  });

  it("keeps mouse wheel graph scrolling live while a stage-local HIL request is active", () => {
    const stages = [
      makeAwaitingInputStage("stage-0", [], {
        inputRequest: makeInputRequest(),
      }),
      makeStage("stage-1", ["stage-0"]),
      makeStage("stage-2", ["stage-1"]),
      makeStage("stage-3", ["stage-2"]),
      makeStage("stage-4", ["stage-3"]),
      makeStage("stage-5", ["stage-4"]),
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
    });

    view.render(96);
    view.handleInput(SGR_MOUSE_WHEEL_DOWN);
    view.render(96);
    assert.ok(view._graphScrollOffset > 0);
    view.dispose();
  });

  it("lets legacy run-level prompts keep graph detach, switcher, and scroll controls", () => {
    const stages = [
      makeStage("stage-0"),
      makeStage("stage-1", ["stage-0"]),
      makeStage("stage-2", ["stage-1"]),
      makeStage("stage-3", ["stage-2"]),
      makeStage("stage-4", ["stage-3"]),
      makeStage("stage-5", ["stage-4"]),
    ];
    const snap = makeRunPromptSnap(
      stages,
      makePendingPrompt({ id: "legacy-prompt" }),
    );
    const store = makeStore(snap);
    let detached = 0;
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onDetach: () => {
        detached += 1;
      },
    });

    view.render(96);
    view.handleInput(SGR_MOUSE_WHEEL_DOWN);
    view.render(96);
    assert.ok(view._graphScrollOffset > 0);

    view.handleInput("/");
    assert.equal(view._switcherOpen, true);
    const switcherText = visibleText(view.render(96));
    assert.match(switcherText, /STAGES/);
    assert.doesNotMatch(switcherText, /AWAITING INPUT/);
    view.handleInput("\x1b");
    assert.equal(view._switcherOpen, false);

    view.handleInput("\x04");
    assert.equal(detached, 1);
    view.dispose();
  });

  it("keeps legacy run-level prompts answerable for text and Enter", () => {
    const stages = [makeStage("stage-0")];
    const snap = makeRunPromptSnap(
      stages,
      makePendingPrompt({ id: "legacy-prompt" }),
    );
    const store = makeStore(snap);
    const resolved: Array<{ runId: string; promptId: string; response: unknown }> = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onPromptResolve: (runId, promptId, response) => {
        resolved.push({ runId, promptId, response });
      },
    });

    view.handleInput("o");
    view.handleInput("k");
    view.handleInput("\r");

    assert.deepEqual(resolved, [
      { runId: "run-1", promptId: "legacy-prompt", response: "ok" },
    ]);
    view.dispose();
  });

  it("ArrowDown scrolls a tall graph so the focused node stays visible", () => {
    const stages = [
      makeStage("stage-0"),
      makeStage("stage-1", ["stage-0"]),
      makeStage("stage-2", ["stage-1"]),
      makeStage("stage-3", ["stage-2"]),
      makeStage("stage-4", ["stage-3"]),
      makeStage("stage-5", ["stage-4"]),
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
    });

    assert.doesNotMatch(visibleText(view.render(96)), /stage-5/);
    for (let i = 0; i < 5; i++) view.handleInput("\x1b[B");
    assert.match(visibleText(view.render(96)), /stage-5/);
    view.dispose();
  });

  it("mouse wheel input scrolls a tall graph without moving focus", () => {
    const stages = [
      makeStage("stage-0"),
      makeStage("stage-1", ["stage-0"]),
      makeStage("stage-2", ["stage-1"]),
      makeStage("stage-3", ["stage-2"]),
      makeStage("stage-4", ["stage-3"]),
      makeStage("stage-5", ["stage-4"]),
    ];
    const snap = makeSnap(stages);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
    });

    view.render(96);
    assert.equal(view._focusedIndex, 0);
    view.handleInput(SGR_MOUSE_WHEEL_DOWN);
    view.render(96);
    assert.equal(view._focusedIndex, 0);
    assert.ok(view._graphScrollOffset > 0);
    view.dispose();
  });

  it("centers the waiting-for-events message in an empty graph body", () => {
    const snap = makeSnap([]);
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 16,
    });
    const width = 80;
    const message = "waiting for stage events…";
    const waitingLine = visibleText(view.render(width))
      .split("\n")
      .find((line) => line.includes(message));

    assert.ok(waitingLine, "expected waiting message to render");
    assert.equal(
      waitingLine.indexOf(message),
      Math.floor((width - visibleWidth(message)) / 2),
    );
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

  it("keeps header rows within width for long wide run names", () => {
    const run: RunSnapshot = {
      ...makeRun([makeStage("A")]),
      name: "workflow-测试🚀e\u0301".repeat(20),
    };
    const lines = renderHeader(run, { width: 40, theme: defaultTheme });
    assertVisibleWidths(lines, 40);
  });

  it("keeps node cards exactly NODE_W cells with wide stage names", () => {
    for (const name of ["测试测试测试测试测试", "build 🚀🚀🚀🚀", "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301", "👩‍💻 review"].values()) {
      const lines = renderNodeCard(
        { ...makeStage("wide"), name },
        { width: NODE_W, theme: defaultTheme, focused: true },
      );
      assertVisibleWidths(lines, NODE_W);
    }
  });

  it("renders paused node cards with an explicit pause state", () => {
    const lines = renderNodeCard(
      { ...makeStage("paused"), status: "paused" },
      { width: NODE_W, theme: defaultTheme },
    );
    assertVisibleWidths(lines, NODE_W);
    assert.match(visibleText(lines), /❚❚ paused/);
  });

  it("keeps composed graph rows within width for wide run and stage names", () => {
    const stages = [
      { ...makeStage("A"), name: "root-测试🚀".repeat(8) },
      { ...makeStage("B", ["A"]), name: "child-👩‍💻-e\u0301".repeat(8) },
    ];
    const snap: StoreSnapshot = {
      ...makeSnap(stages),
      runs: [
        {
          ...makeRun(stages),
          name: "run-测试🚀e\u0301".repeat(20),
        },
      ],
    };
    const store = makeStore(snap);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 20,
    });
    const lines = view.render(40);
    assert.equal(lines.length, 20);
    assertVisibleWidths(lines, 40);
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
    // Tick is 100ms, but Windows CI can starve the event loop long enough
    // that one wall-clock sleep observes only one interval turn. Poll across
    // scheduler turns instead of assuming 250ms means two ticks.
    try {
      await waitForRenderCount(() => requestRender.mock.calls.length, 2);
      assert.ok(
        requestRender.mock.calls.length >= 2,
        `expected ≥ 2 ticks, got ${requestRender.mock.calls.length}`,
      );
    } finally {
      view.dispose();
    }
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
    const originalNow = Date.now;
    let view: GraphView | undefined;
    try {
      Date.now = () => 4_000;
      const startedAt = 0;
      const stages: StageSnapshot[] = [
        { ...makeStage("A"), status: "running" as const, startedAt },
        { ...makeStage("B", ["A"]), status: "running" as const, startedAt },
      ];
      const snap = makeSnap(stages);
      const store = makeStore(snap);
      view = new GraphView({
        mode: "overlay",
        runId: "run-1",
        store,
        graphTheme: defaultTheme,
      });
      const frameA = view.render(96).join("\n");
      // Advance to a deterministic point in the 2s pulse cycle (~25%
      // of period) without crossing a duration-formatting boundary,
      // so the frame delta specifically covers the border pulse.
      Date.now = () => 4_500;
      const frameB = view.render(96).join("\n");
      assert.notEqual(frameA, frameB, "pulse phase must change between renders");
    } finally {
      view?.dispose();
      Date.now = originalNow;
    }
  });
});
