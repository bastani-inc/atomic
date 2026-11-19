import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/color-utils.js";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphThemeFromPiTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { PULSE_PERIOD_MS } from "../../packages/workflows/src/tui/graph-view-constants.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { makeSnap, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

const steps = 20;

afterEach(() => {
	vi.useRealTimers();
	refreshColorEnvironment();
});

/** Each visible cell of a rendered row with whether SGR faint is active on it. */
function faintCells(line: string): { ch: string; faint: boolean }[] {
	const cells: { ch: string; faint: boolean }[] = [];
	let faint = false;
	for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
		if (part.startsWith("\x1b[")) {
			const codes = (part.slice(2, -1) || "0").split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 0 || code === 22) faint = false;
				else if (code === 2) faint = true;
				// Skip an extended colour's mode and value parameters.
				else if (code === 38 || code === 48 || code === 58) i += codes[i + 1] === 2 ? 4 : 2;
			}
		} else {
			for (const ch of part.replace(/\x1b\][^\x07]*\x07/g, "")) cells.push({ ch, faint });
		}
	}
	return cells;
}

function stage(id: string, status: StageSnapshot["status"], parentIds: string[] = []): StageSnapshot {
	return { ...makeStage(id, parentIds), status };
}

for (const neighbour of ["completed", "awaiting_input"] as const) {
	test(`a pulsing stage's quiet phase stays inside its own card next to a ${neighbour} stage (#5596)`, () => {
		refreshColorEnvironment({});
		// A palette-slot theme pulses with SGR faint rather than a dimmer RGB shade.
		const theme = deriveGraphThemeFromPiTheme(loadTheme("dark", "256color"));
		const view = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store: makeStore(
				makeSnap([
					stage("root", "completed"),
					stage("left", "running", ["root"]),
					stage("right", neighbour, ["root"]),
				]),
			),
			graphTheme: theme,
			piTui: makeTestTui(40),
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			let quiet = 0;
			for (let step = 0; step <= steps; step++) {
				vi.setSystemTime((step / steps) * PULSE_PERIOD_MS);
				const rows = view.render(120).map(faintCells);
				const text = rows.map((cells) => cells.map((cell) => cell.ch).join(""));
				const top = text.findIndex((row) => /╭─+ left ─+╮/.test(row));
				assert.ok(top >= 0 && text.some((row) => / right /.test(row)), text.join("\n"));
				const x0 = text[top]!.search(/╭─+ left/);
				const x1 = x0 + /╭─+ left ─+╮/.exec(text[top]!.slice(x0))![0].length;
				let bottom = top + 1;
				while (text[bottom]![x0] !== "╰") bottom++;
				const inLeft = (y: number, x: number) => y >= top && y <= bottom && x >= x0 && x < x1;
				if (rows.some((cells, y) => cells.some((cell, x) => cell.faint && inLeft(y, x)))) quiet++;
				for (const [y, cells] of rows.entries()) {
					for (const [x, cell] of cells.entries()) {
						if (cell.ch === " " || inLeft(y, x)) continue;
						assert.ok(
							!cell.faint,
							`step ${step}: faint ${JSON.stringify(cell.ch)} at row ${y} col ${x}\n${text[y]}`,
						);
					}
				}
			}
			assert.ok(quiet > 0 && quiet < steps + 1, "the running card itself still pulses");
		} finally {
			view.dispose();
		}
	});
}
