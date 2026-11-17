import { test } from "vitest";
import { hexBg } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { assertBackgroundFill } from "../helpers/background-fill.js";
import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
import { makeRun, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

const run = { ...makeRun([makeStage("first")]), name: "A very long workflow name ".repeat(12) };

test("graph chrome fills every cell even when run names and footer hints truncate (#5224)", async () => {
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
