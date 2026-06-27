import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import * as h from "./overlay-graph-helpers.js";

function makeGraphView(opts: {
  ended?: boolean;
  onClose?: () => void;
  onQuit?: (runId: string) => void;
} = {}): GraphView {
  const stages = [h.makeStage("A")];
  const baseRun = h.makeRun(stages);
  const snap = opts.ended === true
    ? {
        runs: [{ ...baseRun, status: "completed" as const, endedAt: Date.now() }],
        notices: [],
        version: 1,
      }
    : h.makeSnap(stages);
  return new GraphView({
    mode: "overlay",
    runId: "run-1",
    store: h.makeStore(snap),
    graphTheme: h.defaultTheme,
    onClose: opts.onClose,
    onQuit: opts.onQuit,
  });
}

describe("GraphView q quit handling", () => {
  it("requests live-run quit without speculatively closing", () => {
    const onClose = mock(() => {});
    const quit: string[] = [];
    const view = makeGraphView({
      onClose,
      onQuit: (runId) => quit.push(runId),
    });

    assert.equal(view.handleInput("q"), true);
    assert.deepEqual(quit, ["run-1"]);
    assert.equal(onClose.mock.calls.length, 0);
    view.dispose();
  });

  it("falls through when q has no live run and no close handler", () => {
    const quit: string[] = [];
    const view = makeGraphView({
      ended: true,
      onQuit: (runId) => quit.push(runId),
    });

    assert.equal(view.handleInput("q"), false);
    assert.deepEqual(quit, []);
    view.dispose();
  });
});
