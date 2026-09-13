import assert from "node:assert/strict";
import { test } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { defaultTheme, makeSnap, makeStage, makeStore, visibleText } from "./overlay-graph-helpers.js";

test("graph omits single and multiple dependency counts while retaining edges and authored labels", () => {
	const stages = [makeStage("root"), makeStage("dep", ["root"]), makeStage("deps", ["root", "dep"])];
	stages[1]!.model = "dep-deps";
	const before = structuredClone(stages);
	const view = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap(stages)),
		graphTheme: defaultTheme,
	});
	try {
		const rendered = visibleText(view.render(160));
		assert.doesNotMatch(rendered, /\b\d+ deps?\b/);
		assert.match(rendered, /root/);
		assert.match(rendered, /dep-deps/);
		assert.match(rendered, /deps/);
		assert.equal(rendered.split("\n").filter((line) => /^\s*│\s*$/.test(line)).length, 6);
		assert.deepEqual(stages, before);
	} finally {
		view.dispose();
	}
});

test("fan-in graph retains branching connectors without a plural dependency label", () => {
	const stages = [makeStage("left"), makeStage("right"), makeStage("join", ["left", "right"])];
	// Keep duration text present so a dash would identify an unwanted model placeholder.
	for (const stage of stages) stage.durationMs = 1200;
	const before = structuredClone(stages);
	const view = new GraphView({
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap(stages)),
		graphTheme: defaultTheme,
	});
	try {
		const rendered = visibleText(view.render(160));
		assert.doesNotMatch(rendered, /\b\d+ deps?\b/);
		assert.doesNotMatch(rendered, /\broot\b|—/);
		assert.match(rendered, /[┬┴┼├┤]/);
		assert.match(rendered, /left/);
		assert.match(rendered, /right/);
		assert.match(rendered, /join/);
		assert.deepEqual(stages, before);
	} finally {
		view.dispose();
	}
});
