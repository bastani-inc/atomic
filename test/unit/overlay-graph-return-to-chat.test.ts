// @ts-nocheck
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import * as h from "./overlay-graph-helpers.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
const { makeStage, makeSnap, makeRunPromptSnap, makePendingPrompt, makeStore, makeRun, defaultTheme, visibleText, makeView } = h;

describe("GraphView return to main chat", () => {
  it("q returns a nested workflow graph to main chat without changing workflow lifecycle", () => {
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
          startedAt: Date.now(),
        },
      ],
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
      onDetach: () => {
        returnedToChat += 1;
      },
    });

    view.handleInput("q");

    assert.equal(returnedToChat, 1);
    assert.deepEqual(snap.runs, before);
    view.dispose();
  });

  it("q uses the same return-to-main-chat callback as Ctrl+D", () => {
    const stages = [makeStage("A")];
    const onDetach = mock(() => {});
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store: makeStore(makeSnap(stages)),
      graphTheme: defaultTheme,
      onDetach,
    });
    view.handleInput("q");
    assert.equal(onDetach.mock.calls.length, 1);
    view.dispose();
  });

  it("q returns to main chat before a visible legacy prompt can consume it", () => {
    const store = makeStore(
      makeRunPromptSnap([makeStage("prompt-owner")], makePendingPrompt({ id: "legacy-prompt" })),
    );
    const resolved: h.PromptResolution[] = [];
    let returnedToChat = 0;
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onDetach: () => {
        returnedToChat += 1;
      },
      onPromptResolve: (runId, promptId, response) => {
        resolved.push({ runId, promptId, response });
      },
    });

    assert.equal(view.promptState?.rawText, "");
    view.handleInput("q");

    assert.equal(returnedToChat, 1);
    assert.equal(view.promptState?.rawText, "");
    assert.deepEqual(resolved, []);
    view.dispose();
  });

  it.each([
    ["q", "q"],
    ["Ctrl+D", "\x04"],
  ])("%s returns to main chat while the stage switcher is open", (_label, key) => {
    const store = makeStore(makeSnap([makeStage("A"), makeStage("B")]));
    let returnedToChat = 0;
    const before = structuredClone(store.runs());
    const view = new GraphView({
      mode: "overlay",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
      onDetach: () => {
        returnedToChat += 1;
      },
    });

    view.handleInput("/");
    assert.equal(view._switcherOpen, true);
    view.handleInput(key);

    assert.equal(returnedToChat, 1);
    assert.deepEqual(store.runs(), before);
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

  it("render shows orchestrator chrome and graph mode pill", () => {
    const stages = [makeStage("A"), makeStage("B", ["A"])];
    const view = makeView(stages);
    const text = visibleText(view.render(96));
    // Header pill carries the ORCHESTRATOR label in all caps.
    assert.match(text, /ORCHESTRATOR/);
    // Bottom statusline carries the GRAPH mode pill.
    assert.match(text, /GRAPH/);
    // Both graph-exit keys clearly return to main chat; q is no longer a
    // lifecycle quit affordance.
    assert.match(text, /navigate/);
    assert.match(text, /attach/);
    assert.match(text, /stages/);
    assert.match(text, /q\s+return to main chat/i);
    assert.doesNotMatch(text, /q\s+(?:quit|detach)/i);
    view.dispose();
  });
});
