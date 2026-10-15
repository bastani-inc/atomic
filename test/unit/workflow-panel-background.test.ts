import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { hexBg } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { createSessionPickerState, renderSessionPicker } from "../../packages/workflows/src/tui/session-picker.js";
import { assertBackgroundFill } from "../helpers/background-fill.js";
import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
import { makeRun, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

const run = { ...makeRun([makeStage("first")]), name: "A very long workflow name ".repeat(12) };

test("graph chrome fills every cell even when run names and footer hints truncate", async () => {
	const theme = deriveGraphTheme();
	for (const width of [40, 64, 120]) {
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: run.id,
			store: makeStore({ runs: [run], notices: [], version: 1 }),
			graphTheme: theme,
			piTui: makeTestTui(30),
		});
		try {
			const rows = view.render(width);
			await assertBackgroundFill(rows.slice(1, 4), width, hexBg(theme.backgroundPanel));
			await assertBackgroundFill(rows.slice(-4, -1), width, hexBg(theme.backgroundPanel));
		} finally {
			view.dispose();
		}
	}
});

test("workflow connect picker fills selected, filter, section and empty-state interiors", async () => {
	for (const bg of ["#1e1e2e", "#eff1f5"]) {
		const theme = deriveGraphTheme({ bg });
		for (const width of [40, 64, 120]) {
			for (const populated of [true, false]) {
				const state = { ...createSessionPickerState(), query: "filter ".repeat(30), filterFocused: true };
				const rows = renderSessionPicker({
					width,
					theme,
					state,
					rows: populated ? [{ run, bucket: "active" }] : [],
				});
				const body = rows.filter((line) => stripVTControlCharacters(line).startsWith("│"));
				assert.ok(body.length > 0);
				if (populated) assert.ok(body.some((line) => line.includes(hexBg(theme.accent))));
				for (const line of body) {
					await assertBackgroundFill(
						[line],
						width,
						hexBg(line.includes(hexBg(theme.accent)) ? theme.accent : theme.bg),
						1,
					);
				}
			}
		}
	}
});
