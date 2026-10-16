import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createReplayStageContext } from "../../packages/workflows/src/runs/foreground/executor-stage-replay.js";
import type { WorkflowExitCleanup } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

function replay(persistence: WorkflowPersistencePort) {
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "replay",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	const stage: StageSnapshot = { id: "stage", name: "saved", status: "running", parentIds: [], toolEvents: [] };
	let cleanup!: WorkflowExitCleanup;
	const context = createReplayStageContext({
		runId: "run",
		name: "saved",
		stageId: "stage",
		stageSnapshot: stage,
		replaySource: { ...stage, status: "completed", result: "saved result" },
		activeStore: store,
		opts: { persistence },
		tracker: new GraphFrontierTracker(),
		registerWorkflowExitCleanup(_id, registered) {
			cleanup = registered;
			return () => {};
		},
		workflowExitSkippedReason: (reason) => `workflow-exit: ${reason}`,
		throwIfWorkflowExitSelected() {},
	});
	return { context, stage, cleanup: () => cleanup };
}

test("constructing a replay handle performs no asynchronous persistence", async () => {
	const calls: string[] = [];
	const { context } = replay({
		appendEntry: async (type) => {
			calls.push(type);
		},
	});
	assert.equal(context instanceof Promise, false);
	await sleep(0);
	assert.deepEqual(calls, []);
});

test("replay operations await one ordered start and end commit", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls: string[] = [];
	const { context } = replay({
		appendEntry: async (type) => {
			calls.push(type);
			if (type === "workflow.stage.end") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	let firstSettled = false;
	let secondSettled = false;
	const first = context.prompt("unused").then((result) => {
		firstSettled = true;
		return result;
	});
	const second = context.complete("unused").then((result) => {
		secondSettled = true;
		return result;
	});
	await entered.promise;
	await sleep(0);
	try {
		assert.equal(firstSettled, false);
		assert.equal(secondSettled, false);
		assert.deepEqual(calls, ["workflow.stage.start", "workflow.stage.end"]);
	} finally {
		release.resolve();
	}
	assert.deepEqual(await Promise.all([first, second]), ["saved result", "saved result"]);
});

test("concurrent replay operations receive the identical typed start rejection", async () => {
	const failure = new SessionConflictError("session", 1, 2);
	let starts = 0;
	const { context } = replay({
		appendEntry: async () => {
			starts++;
			throw failure;
		},
	});
	const first = context.prompt("unused");
	const second = context.complete("unused");
	await Promise.all([
		assert.rejects(first, (error) => error === failure),
		assert.rejects(second, (error) => error === failure),
	]);
	assert.equal(starts, 1);
});

test("exit-first replay cleanup commits start before its terminal entry", async () => {
	const calls: string[] = [];
	const { stage, cleanup } = replay({
		appendEntry: async (type) => {
			calls.push(type);
		},
	});
	await cleanup().skipForWorkflowExit("stop");
	assert.deepEqual(calls, ["workflow.stage.start", "workflow.stage.end"]);
	assert.equal(stage.status, "skipped");
	assert.equal(stage.skippedReason, "workflow-exit: stop");
});
