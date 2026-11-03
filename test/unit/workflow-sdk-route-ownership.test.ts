import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createStandaloneRouteOwnership } from "../../packages/workflows/src/runs/foreground/sdk-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { holdFinishedRuns } from "../helpers/finished-runs.js";

function stage(id: string, fields: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "running", ...fields } as StageSnapshot;
}

function runSnapshot(id: string, fields: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, stages: [], toolNodes: [], startedAt: 1, ...fields } as RunSnapshot;
}

/** A root running one child through a boundary, the child's agent stage deliverable or not. */
function rootWithChild(root: string, deliverable: boolean): RunSnapshot[] {
	const child = `${root}-child`;
	return [
		runSnapshot(root, {
			stages: [stage(`${root}-boundary`, { workflowChildRun: { runId: child } } as Partial<StageSnapshot>)],
		}),
		runSnapshot(child, {
			parentRunId: root,
			parentStageId: `${root}-boundary`,
			rootRunId: root,
			stages: [stage(`${child}-agent`, { pendingStageDeliveryAvailable: deliverable })],
		}),
	];
}

test("a standalone host owns the routes of runs under its own roots once one of their stages can take deliveries", () => {
	const store = createStore();
	for (const run of [...rootWithChild("mine", false), ...rootWithChild("other", true)]) store.recordRunStart(run);
	const ownership = createStandaloneRouteOwnership(store, new Map([["mine", 1]]));
	try {
		assert.equal(ownership.owns("mine"), false, "no stage of the root can take deliveries yet");
		assert.equal(ownership.owns("mine-child"), false);
		assert.equal(ownership.owns("other-child"), false, "another host's root is never announced here");

		const [, child] = rootWithChild("mine", true);
		store.recordRunStart(child!);
		assert.equal(ownership.owns("mine"), true);
		assert.equal(ownership.owns("mine-child"), true);
		assert.equal(ownership.owns("other"), false);

		store.recordRunStart(rootWithChild("mine", false)[1]!);
		assert.equal(ownership.owns("mine-child"), true, "an activated root stays activated");
	} finally {
		ownership.dispose();
	}
});

test("ownership never reads the run list, and after a change to one run reads none of the finished runs the store holds (#4174, #4190)", () => {
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	for (const run of rootWithChild("mine", true)) store.recordRunStart(run);
	const ownership = createStandaloneRouteOwnership(store, new Map([["mine", 1]]));
	const runIds = store.runs().map((run) => run.id);
	const reads = vi.spyOn(store, "runs");
	try {
		// An announcement of every route asks about every run. Ownership used to rebuild an index of every run for
		// each answer (#4174), then once per store version, so each store change cost a pass over the whole store.
		reads.mockClear();
		assert.deepEqual(
			runIds.filter((runId) => ownership.owns(runId)),
			["mine", "mine-child"],
		);
		assert.equal(reads.mock.calls.length, 0, "answering every run reads no run list");

		// A change to one run of the root: the announcement that follows asks only about the root's own runs.
		store.recordStageSession("mine-child", "mine-child-agent", { sessionId: "session" });
		reads.mockClear();
		finished.reads = 0;
		assert.deepEqual(
			["mine", "mine-child"].map((runId) => ownership.owns(runId)),
			[true, true],
		);
		assert.deepEqual([reads.mock.calls.length, finished.reads], [0, 0], "run-list reads and finished-run reads");
	} finally {
		reads.mockRestore();
		ownership.dispose();
	}
});

test("ownership follows the next store version after a run is added, its boundary ends or it is removed (#4190)", () => {
	const store = createStore();
	const [root, child] = rootWithChild("mine", false);
	store.recordRunStart(root!);
	store.recordRunStart(child!);
	const ownership = createStandaloneRouteOwnership(store, new Map([["mine", 1]]));
	const owns = (...runIds: string[]) => runIds.map((runId) => ownership.owns(runId));
	try {
		assert.deepEqual(owns("mine", "mine-child"), [false, false], "no stage of the root can take deliveries yet");

		store.recordRunStart({
			...root!,
			stages: [
				...root!.stages,
				stage("late-boundary", { workflowChildRun: { runId: "mine-late" } } as Partial<StageSnapshot>),
			],
		});
		store.recordRunStart(
			runSnapshot("mine-late", {
				parentRunId: "mine",
				parentStageId: "late-boundary",
				rootRunId: "mine",
				stages: [stage("late-agent", { pendingStageDeliveryAvailable: true })],
			}),
		);
		assert.deepEqual(owns("mine", "mine-child", "mine-late"), [true, true, true], "an added run activates its root");

		store.recordStageEnd("mine", { ...stage("late-boundary"), status: "failed" });
		assert.deepEqual(owns("mine", "mine-late"), [true, false], "a failed boundary releases its child");

		assert.equal(store.removeRun("mine-child"), true);
		assert.deepEqual(owns("mine", "mine-child"), [true, false], "a removed run is no longer the root's");
	} finally {
		ownership.dispose();
	}
});
