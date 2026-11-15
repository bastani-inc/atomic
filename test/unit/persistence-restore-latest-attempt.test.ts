import assert from "node:assert/strict";
import { test } from "vitest";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

function makeSessionManager(entries: readonly SessionEntry[]) {
	return { getEntries: () => entries };
}

/** A run that blocked in its first attempt and was resumed under its own id into a second one, still in flight. */
const RESUMED_AFTER_BLOCK: SessionEntry[] = [
	{ id: "e1", type: "workflow.run.start", payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 } },
	{
		id: "e2",
		type: "workflow.stage.start",
		payload: { runId: "r1", stageId: "s1", name: "review", parentIds: [], ts: 2 },
	},
	{
		id: "e3",
		type: "workflow.run.blocked",
		payload: {
			runId: "r1",
			failedStageId: "s1",
			error: "rate limited",
			failureKind: "unknown",
			failureRecoverability: "recoverable",
			resumable: true,
			ts: 3,
		},
	},
	{
		id: "e4",
		type: "workflow.run.start",
		payload: { runId: "r1", name: "wf", inputs: {}, resumedFromRunId: "r1", accumulatedDurationMs: 500, ts: 10 },
	},
];

test("a restored resumed attempt keeps its own start metadata (#4874)", () => {
	const store = createStore();
	restoreOnSessionStart(makeSessionManager(RESUMED_AFTER_BLOCK), { resumeInFlight: "auto", persistRuns: true }, store);
	const run = store.run("r1");
	assert.equal(run?.resumedFromRunId, "r1");
	assert.equal(run?.accumulatedDurationMs, 500);
});

test("a restored resumed attempt is not blocked by the attempt before it (#4874)", () => {
	const store = createStore();
	restoreOnSessionStart(makeSessionManager(RESUMED_AFTER_BLOCK), { resumeInFlight: "auto", persistRuns: true }, store);
	assert.equal(store.run("r1")?.status, "running");
	assert.equal(store.run("r1")?.blockedAt, undefined);
});

test("a run blocked in its latest attempt is restored blocked (#4874)", () => {
	const store = createStore();
	restoreOnSessionStart(
		makeSessionManager([
			...RESUMED_AFTER_BLOCK,
			{
				id: "e5",
				type: "workflow.run.blocked",
				payload: {
					runId: "r1",
					failedStageId: "s1",
					error: "rate limited again",
					failureKind: "unknown",
					failureRecoverability: "recoverable",
					resumable: true,
					ts: 11,
				},
			},
		]),
		{ resumeInFlight: "auto", persistRuns: true },
		store,
	);
	assert.equal(store.run("r1")?.blockedAt, 11);
	assert.equal(store.run("r1")?.error, "rate limited again");
});
