import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function stage(id: string): StageSnapshot {
	return { id, name: id, status: "running", parentIds: [], toolEvents: [] } as StageSnapshot;
}

function run(): RunSnapshot {
	return {
		id: "run-1",
		name: "wf",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage("s1")],
		startedAt: 1,
	};
}

test("records a stage's background compaction state and publishes it to observers (#4330)", () => {
	const store = createStore();
	store.recordRunStart(run());
	let notifications = 0;
	const changes: unknown[] = [];
	const unsubscribe = store.subscribeInvalidation((scoped) => {
		notifications += 1;
		changes.push(scoped);
	});
	try {
		assert.equal(store.recordStageCompaction("missing-run", "s1", { state: "running" }), false);
		assert.equal(store.recordStageCompaction("run-1", "missing-stage", { state: "running" }), false);
		assert.equal(notifications, 0, "unknown targets notify nobody");

		const failed = {
			state: "failed" as const,
			upToEntryId: "e9",
			startedAt: "2026-11-05T00:00:00.000Z",
			error: {
				name: "BackgroundCompactionPlanningError",
				code: "planner-failed" as const,
				message: "m",
				hint: "h",
				retryable: true,
				phase: "plan" as const,
				fields: { upToEntryId: "e9", attempt: 1 },
			},
		};
		assert.equal(store.recordStageCompaction("run-1", "s1", failed), true);
		assert.equal(notifications, 1);
		assert.deepEqual(changes, [[{ runId: "run-1", stageId: "s1" }]], "only this stage's run is invalidated");
		const recorded = store.graphRun("run-1")?.stages.find((item) => item.id === "s1");
		assert.deepEqual(recorded?.compaction, failed);
		assert.deepEqual(summarizeStage(recorded as StageSnapshot).compaction, failed);
		assert.equal("compaction" in summarizeStage(stage("s2")), false, "a stage without a session has no state");
	} finally {
		unsubscribe();
	}
});
