import assert from "node:assert/strict";
import type { TuiMouseEvent } from "@bastani/atomic-tui";
import { describe, it } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
import { ANSI_RE, defaultTheme, makeSnap, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

function sgrMousePress(col: number, row: number, buttonCode = 0, final = "M"): string {
	return `\x1b[<${buttonCode};${col + 1};${row + 1}${final}`;
}

/** The click the renderer sends after a press and release on the first cell of `text` in the rendered buffer. */
function clickRenderedText(lines: string[], text: string): TuiMouseEvent {
	const plainLines = lines.map((line) => line.replace(ANSI_RE, ""));
	const row = plainLines.findIndex((line) => line.includes(text));
	assert.notEqual(row, -1, `expected rendered text ${text}`);
	const col = plainLines[row]!.indexOf(text);
	assert.notEqual(col, -1, `expected rendered text ${text}`);
	return clickAt(col, row);
}

/** The click the renderer sends after a press and release on one cell. */
function clickAt(col: number, row: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: col,
		y: row,
		screenX: col,
		screenY: row,
		width: 96,
		height: 32,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("GraphView rendered node hit rects", () => {
	it("opens nodes by clicking cells found in the rendered buffer", () => {
		const stages = [makeStage("root"), makeStage("middle", ["root"]), makeStage("target-node", ["middle"])];
		const store = makeStore(makeSnap(stages));
		const attached: string[] = [];
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
			onStageAttach: (_runId, stageId) => attached.push(stageId),
		});

		const lines = view.render(96);
		assert.deepEqual(view.handleMouse(clickRenderedText(lines, "target-node")), { handled: true });

		assert.equal(view._focusedIndex, 2);
		assert.deepEqual(attached, ["target-node"]);
		view.dispose();
	});

	it("passes left mouse presses and clicks through in widget mode", () => {
		const stages = [makeStage("root")];
		const store = makeStore(makeSnap(stages));
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "widget",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
		});

		view.render(80);
		assert.equal(view.handleInput(sgrMousePress(1, 1)), false);
		assert.equal(view.handleMouse(clickAt(1, 1)), undefined);
		view.dispose();
	});
});
