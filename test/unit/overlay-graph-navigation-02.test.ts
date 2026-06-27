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

describe("GraphView keyboard navigation", () => {
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
    // Bottom statusline carries the GRAPH mode pill and loop rail.
    assert.match(text, /GRAPH/);
    assert.match(text, /Loop: a → b/);
    // Hints reflect the new vocabulary (navigate / attach / stages /
    // detach / quit) rather than the legacy j\/k focus row.
    assert.match(text, /navigate/);
    assert.match(text, /attach/);
    assert.match(text, /stages/);
    assert.match(text, /detach/);
    view.dispose();
  });

  it("fits the graph loop rail without pushing right-side hints off the statusline", () => {
    const stages = [
      makeStage("prompt-refinement-1"),
      makeStage("research-1", ["prompt-refinement-1"]),
      makeStage("orchestrator-2", ["research-1"]),
      makeStage("reviewer-a", ["orchestrator-2"]),
      makeStage("reviewer-b", ["orchestrator-2"]),
      makeStage("reviewer-c", ["orchestrator-2"]),
    ];
    const view = makeView(stages);
    const wide = visibleText(view.render(128));
    assert.match(wide, /Loop: prompt-refine/);
    assert.match(wide, /navigate/);
    assert.match(wide, /attach/);
    assert.match(wide, /q\s+quit/);

    const medium = visibleText(view.render(96));
    assert.match(medium, /Loop: 4 phases/);
    assert.match(medium, /q\s+quit/);

    const narrow = visibleText(view.render(80));
    assert.match(narrow, /GRAPH/);
    assert.match(narrow, /Loop:/);
    assert.match(narrow, /\/\s+stages/);
    assert.match(narrow, /ctrl\+d\s+detach/);
    assert.match(narrow, /q\s+quit/);

    const belowLoopBudget = visibleText(view.render(72));
    assert.doesNotMatch(belowLoopBudget, /Loop:/);
    assert.match(belowLoopBudget, /↑↓←→/);
    assert.match(belowLoopBudget, /\/\s+stages/);
    assert.match(belowLoopBudget, /ctrl\+d\s+detach/);
    assert.match(belowLoopBudget, /q\s+quit/);
    view.dispose();
  });

  it("keeps full non-loop graph action labels at medium widths", () => {
    const view = makeView([makeStage("single")]);
    for (const width of [80, 84, 88]) {
      const rendered = visibleText(view.render(width));
      assert.doesNotMatch(rendered, /Loop:/);
      assert.match(rendered, /↑↓←→\s+navigate/, `${width}: navigate label`);
      assert.match(rendered, /↵\s+attach/, `${width}: attach label`);
    }
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

  it("honors remapped select keybindings for run-level prompt cards", () => {
    const store = createStore();
    store.recordRunStart(makeRun([makeStage("prompt-owner")]));
    const prompt = {
      id: "prompt-select-1",
      kind: "select" as const,
      message: "Choose a branch.",
      choices: ["alpha", "beta", "gamma"],
      createdAt: Date.now(),
    };
    assert.equal(store.recordPendingPrompt("run-1", prompt), true);
    const resolved: Array<{ runId: string; promptId: string; response: unknown }> = [];
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      getViewportRows: () => 32,
      piKeybindings: makeFakeKeybindings({
        "tui.select.down": ["d"],
        "tui.select.confirm": ["s"],
      }),
      onPromptResolve: (runId, promptId, response) => {
        resolved.push({ runId, promptId, response });
        store.resolvePendingPrompt(runId, promptId, response);
      },
    });

    assert.equal(view.handleInput("d"), true);
    assert.deepEqual(resolved, []);
    assert.equal(store.runs()[0]?.pendingPrompt?.id, prompt.id);

    assert.equal(view.handleInput("s"), true);
    assert.deepEqual(resolved, [{ runId: "run-1", promptId: prompt.id, response: "beta" }]);
    assert.equal(store.runs()[0]?.pendingPrompt, undefined);
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

});
