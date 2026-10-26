/**
 * A graph of many workflow-child cards measures each card's height on every store publish.
 * Wrapping a child run id is the expensive part of that measure, so a publish that changes one
 * card must not re-wrap every card's id: with 320 pooled children it stalled first-wave
 * dispatch for over 600 ms (#3996).
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { defaultTheme } from "./overlay-graph-helpers.js";

const wraps = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../packages/workflows/src/tui/run-identity-rows.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/tui/run-identity-rows.js")>();
	return {
		...actual,
		wrapIdentifierLines: (...args: Parameters<typeof actual.wrapIdentifierLines>) => {
			wraps.count += 1;
			return actual.wrapIdentifierLines(...args);
		},
	};
});

const CHILDREN = 60;

test("a publish that changes one workflow-child card re-wraps O(1) run ids, not one per card (#3996)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "root",
		name: "root",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	for (let index = 0; index < CHILDREN; index++)
		store.recordStageStart("root", {
			id: `spawn-${index}`,
			name: `spawn-${index}`,
			status: "running",
			parentIds: [],
			toolEvents: [],
			workflowChildRun: {
				alias: `child-${index}`,
				workflow: "child",
				runId: `0cfb6302-c508-4b4f-8236-${String(index).padStart(12, "0")}`,
			},
		});
	const view = new GraphView({
		mode: "overlay",
		runId: "root",
		store,
		graphTheme: defaultTheme,
		// As the attach pane does: queue badges can grow a card, so sizing reads them.
		getStageQueuedMessageCount: () => 0,
	});
	try {
		view.render(200);
		wraps.count = 0;

		store.recordStagePaused("root", "spawn-7");
		view.render(200);

		assert.ok(
			wraps.count <= 4,
			`one changed card re-wrapped ${wraps.count} run ids across ${CHILDREN} workflow-child cards`,
		);
	} finally {
		view.dispose();
	}
});
