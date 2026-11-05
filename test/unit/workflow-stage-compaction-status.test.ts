import assert from "node:assert/strict";
import { test } from "vitest";
import { BackgroundCompactionCommitError } from "../../packages/coding-agent/src/core/compaction/background-compaction-errors.js";
import { summarizeStage } from "../../packages/workflows/src/extension/workflow-stage-results.js";
import {
	recordStageSessionCompaction,
	stageSessionCompaction,
} from "../../packages/workflows/src/runs/foreground/stage-background-compaction.js";
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

test("a stage that never compacted shows no compaction state; one that did keeps its final idle (#4330)", () => {
	const store = createStore();
	store.recordRunStart(run());
	let notifications = 0;
	const unsubscribe = store.subscribeInvalidation(() => {
		notifications += 1;
	});
	try {
		assert.equal(store.recordStageCompaction("run-1", "s1", { state: "idle" }), false);
		assert.equal(notifications, 0);
		assert.equal(store.graphRun("run-1")?.stages[0]?.compaction, undefined);

		assert.equal(
			store.recordStageCompaction("run-1", "s1", { state: "running", upToEntryId: "e1", startedAt: "t" }),
			true,
		);
		assert.equal(store.recordStageCompaction("run-1", "s1", { state: "idle" }), true);
		assert.equal(notifications, 2);
		assert.deepEqual(store.graphRun("run-1")?.stages[0]?.compaction, { state: "idle" });
	} finally {
		unsubscribe();
	}
});

test("a stage session reports its current compaction state for stage status, when it has one (#4330)", () => {
	assert.equal(stageSessionCompaction(undefined), undefined);
	assert.equal(stageSessionCompaction({ prompt() {} }), undefined, "a custom session runtime without the state");
	const error = new BackgroundCompactionCommitError(
		{ upToEntryId: "e4", resultEntryId: "r4", attempt: 2 },
		{ cause: new Error("disk full") },
	);
	const reported = stageSessionCompaction({
		compaction: { state: "failed", upToEntryId: "e4", startedAt: "2026-11-05T00:00:00.000Z", error },
	});
	assert.equal(reported?.state, "failed");
	assert.equal(reported?.error?.code, "commit-failed");
	assert.deepEqual(reported?.error?.fields, { upToEntryId: "e4", resultEntryId: "r4", attempt: 2 });
	assert.equal(JSON.parse(JSON.stringify(reported)).error.cause.message, "disk full");
});

test("only a stage session with background compaction records a state (#4330)", () => {
	const recorded: unknown[][] = [];
	const store = {
		recordStageCompaction: (...args: unknown[]) => {
			recorded.push(args);
			return true;
		},
	};
	recordStageSessionCompaction(store, "run-1", "s1", { prompt() {} });
	recordStageSessionCompaction(store, "run-1", "s1", undefined);
	assert.deepEqual(recorded, []);
	recordStageSessionCompaction(store, "run-1", "s1", { compaction: { state: "idle" } });
	assert.deepEqual(recorded, [["run-1", "s1", { state: "idle" }]]);
});
