// @ts-nocheck
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import * as h from "./overlay-graph-helpers.js";
import { computeLayout, NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
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

function sgrMousePress(col: number, row: number, buttonCode = 0, final = "M"): string {
  return `\x1b[<${buttonCode};${col + 1};${row + 1}${final}`;
}

function graphNodeClick(
  stages: ReturnType<typeof makeStage>[],
  index: number,
  opts: { width?: number; rows?: number; scrollRows?: number; scrollCols?: number } = {},
): string {
  const width = opts.width ?? 96;
  const rows = opts.rows ?? 32;
  const scrollRows = opts.scrollRows ?? 0;
  const scrollCols = opts.scrollCols ?? 0;
  const layout = computeLayout(stages, { orientation: "vertical" });
  const node = layout[index]!;
  const marginRows = rows >= 9 ? 1 : 0;
  const panelRows = Math.max(7, rows - marginRows * 2);
  const bodyRows = Math.max(1, panelRows - 6);
  const totalGraphRows = Math.max(1, ...layout.map((n) => n.y + NODE_H));
  const topPad = totalGraphRows <= bodyRows
    ? Math.min(3, Math.max(0, Math.floor((bodyRows - totalGraphRows) / 2)))
    : 0;
  const graphInner = Math.max(1, Math.max(40, width) - 4);
  const canvasWidth = layout.reduce((max, n) => Math.max(max, n.x + NODE_W), 0);
  const leftMargin = Math.max(
    2,
    canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2,
  );
  return sgrMousePress(
    leftMargin + node.x - scrollCols + 2,
    marginRows + 3 + topPad + node.y - scrollRows + 2,
  );
}

describe("GraphView keyboard navigation", () => {
  it("opens a visible graph node when clicked directly", () => {
    const stages = [makeStage("stage-0"), makeStage("stage-1", ["stage-0"]), makeStage("stage-2", ["stage-1"])];
    const store = makeStore(makeSnap(stages));
    const attached: Array<{ runId: string; stageId: string }> = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (runId, stageId) => attached.push({ runId, stageId }),
    });

    view.render(96);
    assert.equal(view.handleInput(graphNodeClick(stages, 1)), true);

    assert.equal(view._focusedIndex, 1);
    assert.deepEqual(attached, [{ runId: "run-1", stageId: "stage-1" }]);
    view.dispose();
  });

  it("updates graph focus before activating a clicked node", () => {
    const stages = [makeStage("stage-0"), makeStage("stage-1", ["stage-0"]), makeStage("stage-2", ["stage-1"])];
    const store = makeStore(makeSnap(stages));
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.render(96);
    assert.equal(view._focusedIndex, 0);
    view.handleInput(graphNodeClick(stages, 2));

    assert.equal(view._focusedIndex, 2);
    assert.deepEqual(attached, ["stage-2"]);
    view.dispose();
  });

  it("does not open nodes for empty graph space, chrome, releases, or non-left mouse buttons", () => {
    const stages = [makeStage("stage-0"), makeStage("stage-1", ["stage-0"])];
    const store = makeStore(makeSnap(stages));
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.render(96);
    assert.equal(view.handleInput(sgrMousePress(1, 10)), true, "empty graph body click is consumed as a no-op");
    assert.equal(view.handleInput(sgrMousePress(10, 1)), true, "header/chrome click is consumed as a no-op");
    assert.equal(view.handleInput(sgrMousePress(10, 10, 0, "m")), false, "release event is ignored");
    assert.equal(view.handleInput(sgrMousePress(10, 10, 2)), false, "right-click is ignored");

    assert.equal(view._focusedIndex, 0);
    assert.deepEqual(attached, []);
    view.dispose();
  });

  it("hit-tests clicked graph nodes after vertical scrolling", () => {
    const stages = [
      makeStage("stage-0"),
      makeStage("stage-1", ["stage-0"]),
      makeStage("stage-2", ["stage-1"]),
      makeStage("stage-3", ["stage-2"]),
      makeStage("stage-4", ["stage-3"]),
      makeStage("stage-5", ["stage-4"]),
    ];
    const store = makeStore(makeSnap(stages));
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.render(96);
    view.handleInput(SGR_MOUSE_WHEEL_DOWN);
    view.handleInput(SGR_MOUSE_WHEEL_DOWN);
    view.render(96);
    const scrollRows = view._graphScrollOffset;
    assert.ok(scrollRows > 0);

    view.handleInput(graphNodeClick(stages, 2, { scrollRows }));

    assert.equal(view._focusedIndex, 2);
    assert.deepEqual(attached, ["stage-2"]);
    view.dispose();
  });

  it("hit-tests clicked graph nodes after horizontal scrolling", () => {
    const stages = [
      makeStage("root"),
      makeStage("child-0", ["root"]),
      makeStage("child-1", ["root"]),
      makeStage("child-2", ["root"]),
      makeStage("child-3", ["root"]),
      makeStage("child-4", ["root"]),
      makeStage("child-5", ["root"]),
    ];
    const store = makeStore(makeSnap(stages));
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.render(48);
    const scrollCols = view._graphScrollColOffset;
    assert.ok(scrollCols > 0);

    view.handleInput(graphNodeClick(stages, 0, { width: 48, scrollCols }));

    assert.equal(view._focusedIndex, 0);
    assert.deepEqual(attached, ["root"]);
    view.dispose();
  });

  it("keeps Enter activation behavior unchanged for the focused graph node", () => {
    const stages = [makeStage("stage-0"), makeStage("stage-1", ["stage-0"])];
    const store = makeStore(makeSnap(stages));
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.handleInput("\x1b[B");
    assert.equal(view._focusedIndex, 1);
    assert.equal(view.handleInput("\r"), true);

    assert.deepEqual(attached, ["stage-1"]);
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
