/**
 * Phase C tests — GraphFrontierTracker
 * Covers: sequential, parallel (Promise.all-like), fan-in parent inference, reset.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { GraphFrontierTracker } from "../../packages/workflows/src/runs/shared/graph-inference.js";

describe("GraphFrontierTracker — Phase C", () => {
	// -------------------------------------------------------------------------
	// Sequential
	// -------------------------------------------------------------------------

	describe("sequential execution", () => {
		test("first stage has no parents", () => {
			const tracker = new GraphFrontierTracker();
			const parents = tracker.onSpawn("s1", "first");
			assert.deepEqual(parents, []);
		});

		test("each awaited stage depends on the previous settled stage", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("s1", "stage-one");
			tracker.onSettle("s1");

			const p2 = tracker.onSpawn("s2", "stage-two");
			assert.deepEqual(p2, ["s1"]);
			tracker.onSettle("s2");

			const p3 = tracker.onSpawn("s3", "stage-three");
			assert.deepEqual(p3, ["s2"]);
			tracker.onSettle("s3");
		});

		test("three-stage chain: correct parent IDs on nodes", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("a", "alpha");
			tracker.onSettle("a");
			tracker.onSpawn("b", "beta");
			tracker.onSettle("b");
			tracker.onSpawn("c", "gamma");
			tracker.onSettle("c");

			assert.deepEqual(tracker.getParents("a"), []);
			assert.deepEqual(tracker.getParents("b"), ["a"]);
			assert.deepEqual(tracker.getParents("c"), ["b"]);
		});

		test("getNodes reflects correct parentIds after sequential run", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("n1", "node-one");
			tracker.onSettle("n1");
			tracker.onSpawn("n2", "node-two");
			tracker.onSettle("n2");

			const nodes = tracker.getNodes();
			assert.equal(nodes.length, 2);

			const n2 = nodes.find((n) => n.id === "n2");
			assert.deepEqual(n2?.parentIds, ["n1"]);
		});
	});

	// -------------------------------------------------------------------------
	// Parallel (Promise.all-like)
	// -------------------------------------------------------------------------

	describe("parallel execution (Promise.all-like)", () => {
		test("two stages spawned before either settles share the same frontier", () => {
			const tracker = new GraphFrontierTracker();

			// Root stage settled first
			tracker.onSpawn("root", "root");
			tracker.onSettle("root");

			// Both branches spawned before either settles — like Promise.all
			const pA = tracker.onSpawn("branchA", "branch-a");
			const pB = tracker.onSpawn("branchB", "branch-b");

			assert.deepEqual(pA, ["root"]);
			assert.deepEqual(pB, ["root"]);
		});

		test("parallel root stages: both have empty parents", () => {
			const tracker = new GraphFrontierTracker();

			const pA = tracker.onSpawn("pA", "parallel-a");
			const pB = tracker.onSpawn("pB", "parallel-b");

			assert.deepEqual(pA, []);
			assert.deepEqual(pB, []);
		});

		test("settling order of parallel branches does not affect their parents", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("r", "root");
			tracker.onSettle("r");

			const pA = tracker.onSpawn("a", "a");
			const pB = tracker.onSpawn("b", "b");

			// Settle in reverse order — should not change recorded parents
			tracker.onSettle("b");
			tracker.onSettle("a");

			assert.deepEqual(pA, ["r"]);
			assert.deepEqual(pB, ["r"]);
		});
	});

	// -------------------------------------------------------------------------
	// Fan-in
	// -------------------------------------------------------------------------

	describe("fan-in: stage after Promise.all has all parallel stages as parents", () => {
		test("basic fan-in from two parallel root branches", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("pA", "parallel-a"); // parents: []
			tracker.onSpawn("pB", "parallel-b"); // parents: []

			tracker.onSettle("pA");
			tracker.onSettle("pB");

			const fanInParents = tracker.onSpawn("fanIn", "fan-in");
			assert.equal(fanInParents.length, 2);
			assert.ok(fanInParents.includes("pA"));
			assert.ok(fanInParents.includes("pB"));
		});

		test("fan-in stage node stores all parallel stages as parentIds", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("x", "x");
			tracker.onSpawn("y", "y");
			tracker.onSettle("x");
			tracker.onSettle("y");
			tracker.onSpawn("z", "z");
			tracker.onSettle("z");

			const zNode = tracker.getNodes().find((n) => n.id === "z");
			assert.equal(zNode?.parentIds.length, 2);
			assert.ok(zNode?.parentIds.includes("x"));
			assert.ok(zNode?.parentIds.includes("y"));
		});

		test("stage after fan-in depends only on the fan-in stage", () => {
			const tracker = new GraphFrontierTracker();

			// Two parallel branches
			tracker.onSpawn("p1", "p1");
			tracker.onSpawn("p2", "p2");
			tracker.onSettle("p1");
			tracker.onSettle("p2");

			// Fan-in
			tracker.onSpawn("fi", "fan-in");
			tracker.onSettle("fi");

			// Post fan-in
			const postParents = tracker.onSpawn("post", "post");
			assert.deepEqual(postParents, ["fi"]);
		});
	});

	// -------------------------------------------------------------------------
	// Reset
	// -------------------------------------------------------------------------

	describe("reset", () => {
		test("reset clears all nodes, parents, and frontier", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("s1", "stage-one");
			tracker.onSettle("s1");
			tracker.reset();

			assert.equal(tracker.getNodes().length, 0);
			assert.deepEqual(tracker.getParents("s1"), []);
		});

		test("after reset, new stages are root stages (empty frontier)", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("old", "old");
			tracker.onSettle("old");
			tracker.reset();

			const parents = tracker.onSpawn("fresh", "fresh");
			assert.deepEqual(parents, []);
		});

		test("stages added after reset tracked independently", () => {
			const tracker = new GraphFrontierTracker();

			tracker.onSpawn("first", "first");
			tracker.onSettle("first");
			tracker.reset();

			tracker.onSpawn("a", "a");
			tracker.onSettle("a");
			tracker.onSpawn("b", "b");
			tracker.onSettle("b");

			assert.deepEqual(tracker.getParents("a"), []);
			assert.deepEqual(tracker.getParents("b"), ["a"]);
			assert.equal(tracker.getNodes().length, 2);
		});
	});
});
