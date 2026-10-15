import assert from "node:assert/strict";
import { test } from "vitest";
import { hexBg } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
import {
	assertVisibleWidths,
	makeSnap,
	makeStage,
	makeStore,
	makeTestTui,
	visibleText,
} from "./overlay-graph-helpers.js";

for (const bg of ["#1e1e2e", "#eff1f5", "#123456"]) {
	test(`graph canvas and node interiors retain the terminal background with palette ${bg}`, () => {
		const theme = deriveGraphTheme({ bg });
		for (const stages of [[], [makeStage("first"), makeStage("second", ["first"])]]) {
			const view = new GraphView({
				piKeybindings: s5aKeybindings(),
				mode: "overlay",
				runId: "run-1",
				store: makeStore(makeSnap(stages)),
				graphTheme: theme,
				piTui: makeTestTui(30),
			});
			try {
				for (const width of [64, 120]) {
					const lines = view.render(width);
					const rendered = lines.join("\n");
					assert.equal(lines.length, 30);
					assertVisibleWidths(lines, width);
					assert.ok(!rendered.includes(hexBg(bg)), "canvas must not paint a fixed palette background");
					assert.ok(rendered.includes("\x1b[49m"), "canvas explicitly restores the terminal background");
					assert.ok(rendered.includes(hexBg(theme.backgroundPanel)), "header/footer keep themed chrome");
					if (stages.length > 0) {
						assert.match(visibleText(lines), /first/);
						assert.ok(rendered.includes(hexBg(theme.accent)), "focused node keeps its accent tab");
					} else {
						assert.match(visibleText(lines), /waiting for stage events/);
					}
				}
			} finally {
				view.dispose();
			}
		}
	});
}
