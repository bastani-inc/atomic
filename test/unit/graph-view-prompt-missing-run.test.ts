import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import {
	defaultTheme,
	makePendingPrompt,
	makeRunPromptSnap,
	makeStage,
	makeStore,
	visibleText,
} from "./overlay-graph-helpers.js";

class MissingPromptAttributionGraphView extends GraphView {
	private renderLookups = 0;

	protected override _getCurrentRun(): RunSnapshot | null {
		this.renderLookups += 1;
		if (this.renderLookups >= 3) return null;
		return super._getCurrentRun();
	}
}

test("pending graph prompt renders when its optional run attribution lookup misses", () => {
	const view = new MissingPromptAttributionGraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeRunPromptSnap([makeStage("prompt-owner")], makePendingPrompt())),
		graphTheme: defaultTheme,
	});

	const rendered = visibleText(view.render(96));

	assert.match(rendered, /AWAITING INPUT/);
	assert.match(rendered, /Continue\?/);
	view.dispose();
});
