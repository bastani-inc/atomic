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
