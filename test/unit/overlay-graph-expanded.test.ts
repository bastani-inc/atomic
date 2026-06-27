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

describe("expanded workflow graph", () => {
  it("rewires parent stages after workflow boundaries to child terminal stages", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "completed",
      workflowChild: {
        alias: "child",
        workflow: "child-workflow",
        runId: "child-run",
        status: "completed",
        outputs: { result: "ok" },
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
          status: "completed",
          stages: [childFirst, childSecond],
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      notices: [],
      version: 1,
    };

    const graph = expandWorkflowGraph(snap, "run-1");
    const after = graph.stages.find((stage) => stage.name === "parent-after");

    assert.deepEqual(after?.parentIds, ["child-run:child-second"]);
  });

  it("flattens the imported workflow: drops the boundary node and inlines child stages", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "completed",
      workflowChild: {
        alias: "child",
        workflow: "child-workflow",
        runId: "child-run",
        status: "completed",
        outputs: { result: "ok" },
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
          status: "completed",
          stages: [childFirst, childSecond],
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      notices: [],
      version: 1,
    };

    const graph = expandWorkflowGraph(snap, "run-1");

    // The boundary "information" node is gone; the nested workflow reads flat.
    assert.equal(graph.stages.some((stage) => stage.name === "workflow:child"), false);
    // Child root inherits the boundary's (empty) incoming parents.
    const first = graph.stages.find((stage) => stage.name === "child-first");
    assert.deepEqual(first?.parentIds, []);
    // Exactly the two inlined child stages + the downstream parent stage remain.
    assert.deepEqual(
      graph.stages.map((stage) => stage.name).sort(),
      ["child-first", "child-second", "parent-after"],
    );
  });

  it("renders a Loop rail for expanded child workflow stages", () => {
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
    const childSecond = makeStage("child-second", ["child-first"]);
    const snap: StoreSnapshot = {
      runs: [
        makeRun([rootBoundary]),
        {
          id: "child-run",
          name: "child-workflow",
          inputs: {},
          status: "running",
          stages: [childFirst, childSecond],
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

    const rendered = visibleText(view.render(128));
    assert.doesNotMatch(rendered, /workflow:child/);
    assert.match(rendered, /child-first/);
    assert.match(rendered, /Loop: child-first → child-second/);
    view.dispose();
  });

  it("keeps the boundary node when the imported workflow has no stages of its own", () => {
    const rootBoundary: StageSnapshot = {
      ...makeStage("workflow:child"),
      status: "completed",
      workflowChild: {
        alias: "child",
        workflow: "child-workflow",
        runId: "child-run",
        status: "completed",
        outputs: { result: "ok" },
      },
    };
    const snap: StoreSnapshot = {
      runs: [
        makeRun([rootBoundary]),
        {
          id: "child-run",
          name: "child-workflow",
          inputs: {},
          status: "completed",
          stages: [],
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      notices: [],
      version: 1,
    };

    const graph = expandWorkflowGraph(snap, "run-1");

    assert.deepEqual(graph.stages.map((stage) => stage.name), ["workflow:child"]);
  });

  it("does not flatten stale child metadata from skipped or failed workflow boundaries", () => {
    for (const status of ["skipped", "failed"] as const) {
      const rootBoundary: StageSnapshot = {
        ...makeStage("workflow:child"),
        status,
        endedAt: Date.now(),
        ...(status === "skipped" ? { skippedReason: "workflow-exit" } : { error: "boom" }),
        workflowChildRun: {
          alias: "child",
          workflow: "child-workflow",
          runId: "child-run",
        },
        workflowChild: {
          alias: "child",
          workflow: "child-workflow",
          runId: "child-run",
          status: "completed",
          outputs: { result: "stale" },
        },
      };
      const rootAfter = makeStage("parent-after", ["workflow:child"]);
      const childFirst = makeStage("child-first");
      const snap: StoreSnapshot = {
        runs: [
          makeRun([rootBoundary, rootAfter]),
          {
            id: "child-run",
            name: "child-workflow",
            inputs: {},
            status: "completed",
            stages: [childFirst],
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        ],
        notices: [],
        version: 1,
      };

      const graph = expandWorkflowGraph(snap, "run-1");
      const after = graph.stages.find((stage) => stage.name === "parent-after");

      assert.equal(graph.stages.some((stage) => stage.name === "child-first"), false);
      assert.equal(graph.stages.some((stage) => stage.name === "workflow:child"), true);
      assert.deepEqual(after?.parentIds, ["workflow:child"]);
    }
  });
});

