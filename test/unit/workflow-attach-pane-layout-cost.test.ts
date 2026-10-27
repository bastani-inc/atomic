/**
 * Laying out a large pooled graph in the attach pane looks each node up once per layout,
 * not by scanning every stage per node (#3996).
 */
import assert from "node:assert/strict";
import { initTheme } from "@bastani/atomic";
import { afterEach, beforeAll, test, vi } from "vitest";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";

const STAGES = 320;

beforeAll(() => {
	initTheme("dark", false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

test("one graph layout with 320 pooled stages scans the stage list O(stages) times, not once per node (#3996)", () => {
	const store = createStore();
	// The shape of a pooled fan-out: each root stage is a child-workflow boundary whose child run
	// holds one agent stage on a local worker.
	store.recordRunStart({
		id: "root",
		name: "fan-out",
		inputs: {},
		status: "running",
		toolNodes: [],
		startedAt: 1,
		stages: Array.from({ length: STAGES }, (_, index) => ({
			id: `work-${index}`,
			name: `work-${index}`,
			status: "running" as const,
			parentIds: [],
			toolEvents: [],
			workflowChildRun: { runId: `child-${index}`, alias: "child", workflow: "child" },
		})),
	});
	for (let index = 0; index < STAGES; index++)
		store.recordRunStart({
			id: `child-${index}`,
			name: "child",
			inputs: {},
			status: "running",
			toolNodes: [],
			startedAt: 1,
			parentRunId: "root",
			parentStageId: `work-${index}`,
			rootRunId: "root",
			stages: [
				{
					id: "agent",
					name: "agent",
					status: "running" as const,
					parentIds: [],
					toolEvents: [],
					model: "fixture/model",
					workerExecution: { worker: "worker", generation: 1, renewedAt: 1, expiresAt: 2 },
					...(index % 7 === 0 ? { queuedUserMessageCount: 2 } : {}),
				},
			],
		});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "root",
		stageControlRegistry: createStageControlRegistry(),
		onClose: () => {},
	});
	try {
		const find = Array.prototype.find;
		let scans = 0;
		vi.spyOn(Array.prototype, "find").mockImplementation(function (
			this: unknown[],
			...args: Parameters<typeof find>
		) {
			if (this.length >= STAGES) scans++;
			return Reflect.apply(find, this, args);
		});
		// A publication rebuilds the layout, as every pool activity batch does.
		store.recordStageStart("root", {
			id: "late",
			name: "late",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		pane.render(200);
		assert.ok(scans <= 4, `one layout scanned the ${STAGES}-stage list ${scans} times`);
	} finally {
		pane.dispose();
	}
});
