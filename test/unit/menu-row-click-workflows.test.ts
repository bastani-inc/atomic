/**
 * One left click opens a `/workflows` row as moving there and pressing Enter would, driven through Atomic's
 * fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	openWorkflowsListing,
	type WorkflowsListingTarget,
} from "../../packages/workflows/src/tui/workflows-listing.js";
import { type ClickScreen, flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function runs(): RunSnapshot[] {
	return ["alpha-objective", "bravo-objective", "charlie-objective"].map(
		(objective, index) =>
			({
				id: `run-${index + 1}-0000`,
				name: "ralph",
				status: "running",
				inputs: { objective },
				stages: [],
				toolNodes: [],
				startedAt: 100_000 - index,
			}) as RunSnapshot,
	);
}

/** Opens `/workflows`; `picked()` is what it settled on, or `"open"` while it is still showing. */
function listing(ui: ClickScreen): { picked(): WorkflowsListingTarget | undefined | "open" } {
	let result: WorkflowsListingTarget | undefined | "open" = "open";
	void openWorkflowsListing(
		{
			custom: ((factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) =>
				new Promise<void>((resolve) => {
					ui.dock(
						factory({ requestRender: () => ui.tui.requestRender(), terminal: ui.terminal }, {}, {}, resolve),
					);
				})) as never,
		},
		{ runs },
	).then((target) => {
		result = target;
	});
	return { picked: () => result };
}

for (const width of [80, 160]) {
	test(`a click on a /workflows run opens it, title or detail line, at ${width} columns`, async () => {
		const ui = makeClickScreen(width);
		const view = listing(ui);
		await flushClicks();
		ui.tui.renderNow();
		const row = ui.rowOf(/bravo-objective/);
		await ui.clickAt(6, row);
		await flushClicks();
		assert.deepEqual(view.picked(), { kind: "run", runId: "run-2-0000" });
		ui.tui.stop();
	});
}

test("the mouse wheel over /workflows moves its selection", async () => {
	const ui = makeClickScreen();
	const view = listing(ui);
	await flushClicks();
	ui.tui.renderNow();
	const row = ui.rowOf(/alpha-objective/);
	await ui.wheel("down", 6, row);
	await ui.wheel("down", 6, row);
	ui.terminal.input("\r");
	await flushClicks();
	assert.deepEqual(view.picked(), { kind: "run", runId: "run-3-0000" });
	ui.tui.stop();
});
