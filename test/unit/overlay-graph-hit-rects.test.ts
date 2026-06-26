import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { ANSI_RE, defaultTheme, makeSnap, makeStage, makeStore } from "./overlay-graph-helpers.js";

function sgrMousePress(col: number, row: number, buttonCode = 0, final = "M"): string {
  return `\x1b[<${buttonCode};${col + 1};${row + 1}${final}`;
}

function clickRenderedText(lines: string[], text: string): string {
  const plainLines = lines.map((line) => line.replace(ANSI_RE, ""));
  const row = plainLines.findIndex((line) => line.includes(text));
  assert.notEqual(row, -1, `expected rendered text ${text}`);
  const col = plainLines[row]!.indexOf(text);
  assert.notEqual(col, -1, `expected rendered text ${text}`);
  return sgrMousePress(col, row);
}

describe("GraphView rendered node hit rects", () => {
  it("opens nodes by clicking cells found in the rendered buffer", () => {
    const stages = [
      makeStage("root"),
      makeStage("middle", ["root"]),
      makeStage("target-node", ["middle"]),
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

    const lines = view.render(96);
    assert.equal(view.handleInput(clickRenderedText(lines, "target-node")), true);

    assert.equal(view._focusedIndex, 2);
    assert.deepEqual(attached, ["target-node"]);
    view.dispose();
  });

  it("passes left mouse presses through in widget mode", () => {
    const stages = [makeStage("root")];
    const store = makeStore(makeSnap(stages));
    const view = new GraphView({
      mode: "widget",
      runId: "run-1",
      store,
      graphTheme: defaultTheme,
    });

    view.render(80);
    assert.equal(view.handleInput(sgrMousePress(1, 1)), false);
    view.dispose();
  });
});
