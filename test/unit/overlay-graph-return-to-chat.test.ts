// @ts-nocheck
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import * as h from "./overlay-graph-helpers.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
const { makeStage, makeSnap, makeRunPromptSnap, makePendingPrompt, makeStore, makeRun, defaultTheme, visibleText, makeView } = h;

const CTRL_X_VARIANTS = ["\x18", "\x1b[120;5u", "\x1b[120;5:1u", "\x1b[27;5;120~"];

describe("GraphView return to main chat", () => {
  it("Ctrl+X returns a nested workflow graph to main chat without changing workflow lifecycle", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "running",
      workflowChildRun: { alias: "child", workflow: "child-workflow", runId: "child-run" },
    };
    const snap: StoreSnapshot = {
      runs: [makeRun([rootBoundary]), {
        id: "child-run",
        name: "child-workflow",
        inputs: {},
        status: "running",
        stages: [makeStage("child-first")],
        startedAt: Date.now(),
      }],
      notices: [],
      version: 1,
    };
    let returnedToChat = 0;
    const before = structuredClone(snap.runs);
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(snap),
      graphTheme: defaultTheme,
      initialFocusedStageId: "child-first",
      onDetach: () => { returnedToChat += 1; },
    });

    view.handleInput("\x18");

    assert.equal(returnedToChat, 1);
    assert.deepEqual(snap.runs, before);
    view.dispose();
  });

  it("Ctrl+X returns before a visible legacy prompt can consume a conflicting editor binding", () => {
    const store = makeStore(
      makeRunPromptSnap([makeStage("prompt-owner")], makePendingPrompt({ id: "legacy-prompt" })),
    );
    const resolved: h.PromptResolution[] = [];
    const onDetach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onDetach,
      onPromptResolve: (runId, promptId, response) => resolved.push({ runId, promptId, response }),
      piKeybindings: makeFakeKeybindings({ "tui.editor.deleteCharForward": ["\x18"] }),
    });

    view.handleInput("\x18");

    assert.equal(onDetach.mock.calls.length, 1);
    assert.equal(view.promptState?.rawText, "");
    assert.deepEqual(resolved, []);
    view.dispose();
  });

  it("Ctrl+X variants return to main chat while the stage switcher is open", () => {
    for (const key of CTRL_X_VARIANTS) {
      const store = makeStore(makeSnap([makeStage("A"), makeStage("B")]));
      const onDetach = mock(() => {});
      const before = structuredClone(store.runs());
      const view = new GraphView({
        mode: "overlay",
        runId: "run-1",
        store,
        graphTheme: defaultTheme,
        onDetach,
      });

      view.handleInput("/");
      assert.equal(view._switcherOpen, true);
      view.handleInput(key);

      assert.equal(onDetach.mock.calls.length, 1, JSON.stringify(key));
      assert.deepEqual(store.runs(), before);
      view.dispose();
    }
  });

  it("q remains printable in the stage switcher instead of navigating or quitting", () => {
    const onDetach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(makeSnap([makeStage("A")])),
      graphTheme: defaultTheme,
      onDetach,
    });

    view.handleInput("/");
    view.handleInput("q");
    assert.equal(view.handleInput("\x04"), false);

    assert.equal(onDetach.mock.calls.length, 0);
    assert.equal(view._switcherState.query, "q");
    view.dispose();
  });

  it("q remains printable in a visible legacy prompt", () => {
    const onDetach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(makeRunPromptSnap([makeStage("A")], makePendingPrompt())),
      graphTheme: defaultTheme,
      onDetach,
      piKeybindings: makeFakeKeybindings(),
    });

    view.handleInput("q");

    assert.equal(onDetach.mock.calls.length, 0);
    assert.equal(view.promptState?.rawText, "q");
    view.dispose();
  });

  it("Ctrl+D no longer returns from the graph", () => {
    const onDetach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(makeSnap([makeStage("A")])),
      graphTheme: defaultTheme,
      onDetach,
    });

    assert.equal(view.handleInput("\x04"), false);
    assert.equal(onDetach.mock.calls.length, 0);
    view.dispose();
  });

  it("render explains the Ctrl+X hierarchy transition", () => {
    const view = makeView([makeStage("A"), makeStage("B", ["A"])]);
    const text = visibleText(view.render(120));

    assert.match(text, /ORCHESTRATOR/);
    assert.match(text, /GRAPH/);
    assert.match(text, /navigate/);
    assert.match(text, /↵ open stage chat/);
    assert.match(text, /stages/);
    assert.match(text, /ctrl\+x\s+leave graph\s+·\s+return to main chat/i);
    assert.doesNotMatch(text, /ctrl\+d|q\s+(?:quit|detach|return)/i);

    const mediumText = visibleText(view.render(96));
    assert.match(mediumText, /↵ open stage chat/);

    const compactText = visibleText(view.render(40));
    assert.match(compactText, /ctrl\+x\s+graph→main chat/i);
    view.dispose();
  });
});
