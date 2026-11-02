import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createStandaloneRouteOwnership } from "../../packages/workflows/src/runs/foreground/sdk-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

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

test("asking about every run of a large store reads the store once per store version (#4174)", () => {
	const store = createStore();
	for (const run of rootWithChild("mine", true)) store.recordRunStart(run);
	for (let index = 0; index < 5_000; index++) store.recordRunStart(runSnapshot(`finished-${index}`));
	const ownership = createStandaloneRouteOwnership(store, new Map([["mine", 1]]));
	const reads = vi.spyOn(store, "runs");
	try {
		// One announcement asks about every run; it used to rebuild the whole run index for each answer.
		const announce = () =>
			store
				.runs()
				.filter((run) => ownership.owns(run.id))
				.map((run) => run.id);
		reads.mockClear();
		assert.deepEqual(announce(), ["mine", "mine-child"]);
		assert.equal(reads.mock.calls.length, 2, "the announcement's own read, plus one index build");

		reads.mockClear();
		announce();
		assert.equal(reads.mock.calls.length, 1, "an unchanged store is not read again");

		store.recordRunStart(runSnapshot("finished-new"));
		reads.mockClear();
		announce();
		assert.equal(reads.mock.calls.length, 2, "a changed store is indexed once more");
	} finally {
		reads.mockRestore();
		ownership.dispose();
	}
});
