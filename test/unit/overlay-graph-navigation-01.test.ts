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
import { Key, visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
const { makeStage, makeSnap, makeRunPromptSnap, makePendingPrompt, makeAwaitingInputStage, makeInputRequest, makeStore, makeRun, defaultTheme, SGR_MOUSE_WHEEL_DOWN, visibleText, assertVisibleWidths, waitForRenderCount, typeIntoView, makeView } = h;

describe("GraphView keyboard navigation", () => {
  it("renders imported child workflow stages inside the parent graph", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "running",
      workflowChildRun: {
        alias: "child",
        workflow: "child-workflow",
        runId: "child-run",
      },
    };
    const rootAfter = makeStage("parent-after", ["workflow:child"]);
    const childFirst = makeStage("child-first");
    const childSecond = makeStage("child-second", ["child-first"]);
    const snap: StoreSnapshot = {
      runs: [
        makeRun([rootBoundary, rootAfter]),
        {
          id: "child-run",
          name: "child-workflow",
          inputs: {},
          status: "running",
          stages: [childFirst, childSecond],
          parentRunId: "run-1",
          parentStageId: "workflow:child",
          rootRunId: "run-1",
          startedAt: Date.now(),
        },
      ],
      notices: [],
      version: 1,
    };
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(snap),
      graphTheme: defaultTheme,
    });

    const text = visibleText(view.render(120));
    // Flattened: the boundary "information" node is not rendered.
    assert.doesNotMatch(text, /workflow:child/);
    assert.match(text, /child-first/);
    assert.match(text, /child-second/);
    view.dispose();
  });

  it("attaches expanded child workflow stages using the child run id", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "running",
      workflowChildRun: {
        alias: "child",
        workflow: "child-workflow",
        runId: "child-run",
      },
    };
    const childFirst = makeStage("child-first");
    const snap: StoreSnapshot = {
      runs: [
        makeRun([rootBoundary]),
        {
          id: "child-run",
          name: "child-workflow",
          inputs: {},
          status: "running",
          stages: [childFirst],
          parentRunId: "run-1",
          parentStageId: "workflow:child",
          rootRunId: "run-1",
          startedAt: Date.now(),
        },
      ],
      notices: [],
      version: 1,
    };
    const attached: Array<{ runId: string; stageId: string }> = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(snap),
      graphTheme: defaultTheme,
      initialFocusedStageId: "child-first",
      onStageAttach: (runId, stageId) => attached.push({ runId, stageId }),
    });

    view.handleInput(Key.enter);

    assert.deepEqual(attached, [{ runId: "child-run", stageId: "child-first" }]);
    view.dispose();
  });

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
    const switcherText = visibleText(view.render(96));
    assert.match(switcherText, /↵ open stage chat/);
    assert.doesNotMatch(switcherText, /↵ attach/);
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

});
