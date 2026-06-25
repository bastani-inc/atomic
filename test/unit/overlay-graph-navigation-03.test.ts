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

  it("lets legacy run-level prompts keep graph detach and scroll controls", () => {
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

    view.handleInput("\x04");
    assert.equal(detached, 1);
    view.dispose();
  });

  it("keeps legacy run-level input prompts answerable with literal slash text", () => {
    const stages = [makeStage("stage-0")];
    const snap = makeRunPromptSnap(
      stages,
      makePendingPrompt({ id: "legacy-prompt" }),
    );
    const store = makeStore(snap);
    const resolved: PromptResolution[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onPromptResolve: (runId, promptId, response) => {
        resolved.push({ runId, promptId, response });
      },
    });

    typeIntoView(view, "/tmp/file");
    view.handleInput("\r");

    assert.equal(view._switcherOpen, false);
    assert.deepEqual(resolved, [
      { runId: "run-1", promptId: "legacy-prompt", response: "/tmp/file" },
    ]);
    view.dispose();
  });

  it("keeps legacy run-level editor prompts answerable with literal slash text", () => {
    const stages = [makeStage("stage-0")];
    const snap = makeRunPromptSnap(
      stages,
      makePendingPrompt({
        id: "legacy-editor-prompt",
        kind: "editor",
        initial: "https://example.test",
      }),
    );
    const store = makeStore(snap);
    const resolved: PromptResolution[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onPromptResolve: (runId, promptId, response) => {
        resolved.push({ runId, promptId, response });
      },
    });

    typeIntoView(view, "/a/b");
    view.handleInput("\t");
    view.handleInput("\r");

    assert.equal(view._switcherOpen, false);
    assert.deepEqual(resolved, [
      {
        runId: "run-1",
        promptId: "legacy-editor-prompt",
        response: "https://example.test/a/b",
      },
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
