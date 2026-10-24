import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function run(id: string): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 0 };
}

test("a store batch notifies its subscribers once, after every mutation it contains (#3903)", () => {
	const store = createStore();
	let invalidations = 0;
	const snapshots: number[] = [];
	store.subscribeInvalidation(() => invalidations++);
	store.subscribe((snapshot) => snapshots.push(snapshot.runs.length));
	const returned = store.batch(() => {
		store.recordRunStart(run("first"));
		store.recordRunStart(run("second"));
		store.batch(() => store.recordRunExecutionState("first", { lastProgressAt: 1 }));
		store.recordRunStart(run("third"));
		assert.equal(invalidations, 0, "nothing is notified while the batch runs");
		return "applied";
	});
	assert.equal(returned, "applied");
	assert.equal(invalidations, 1);
	assert.deepEqual(snapshots, [3]);
});

test("a store batch that throws still notifies once for the mutations it made (#3903)", () => {
	const store = createStore();
	let invalidations = 0;
	store.subscribeInvalidation(() => invalidations++);
	assert.throws(
		() =>
			store.batch(() => {
				store.recordRunStart(run("applied"));
				throw new Error("later mutation failed");
			}),
		/later mutation failed/,
	);
	assert.equal(invalidations, 1);
	assert.deepEqual(
		store.runs().map((entry) => entry.id),
		["applied"],
	);
	store.batch(() => {});
	assert.equal(invalidations, 1, "an empty batch notifies nobody");
});
