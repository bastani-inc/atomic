import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { GraphFrontierTracker } from "../../packages/workflows/src/runs/shared/graph-inference.js";

describe("GraphFrontierTracker", () => {
	test("root stages have no parents", () => {
		const tracker = new GraphFrontierTracker();
		const parents = tracker.onSpawn("s1", "stage-one");
		assert.deepEqual(parents, []);
		tracker.onSettle("s1");

		const nodes = tracker.getNodes();
		assert.equal(nodes.length, 1);
		assert.deepEqual(nodes[0]?.parentIds, []);
	});

	test("sequential: each stage depends on previous", () => {
		const tracker = new GraphFrontierTracker();

		// Simulate: const r1 = await ctx.stage("s1").prompt(...)
		tracker.onSpawn("s1", "stage-one");
		tracker.onSettle("s1");

		// Simulate: const r2 = await ctx.stage("s2").prompt(...)
		const parents2 = tracker.onSpawn("s2", "stage-two");
		assert.deepEqual(parents2, ["s1"]);
		tracker.onSettle("s2");

		const parents3 = tracker.onSpawn("s3", "stage-three");
		assert.deepEqual(parents3, ["s2"]);
		tracker.onSettle("s3");

		const nodes = tracker.getNodes();
		assert.equal(nodes.length, 3);
		assert.deepEqual(tracker.getParents("s1"), []);
		assert.deepEqual(tracker.getParents("s2"), ["s1"]);
		assert.deepEqual(tracker.getParents("s3"), ["s2"]);
	});

	test("parallel: Promise.all stages share same parents", () => {
		const tracker = new GraphFrontierTracker();

		// Root stage
		tracker.onSpawn("s0", "root");
		tracker.onSettle("s0");

		// Parallel: ctx.stage("a") and ctx.stage("b") both spawned before either settles
		const parentsA = tracker.onSpawn("sA", "stage-a");
		const parentsB = tracker.onSpawn("sB", "stage-b");

		// Both see the same frontier (just "s0")
		assert.deepEqual(parentsA, ["s0"]);
		assert.deepEqual(parentsB, ["s0"]);

		tracker.onSettle("sA");
		tracker.onSettle("sB");
	});

	test("fan-in: stage after Promise.all has all parallel stages as parents", () => {
		const tracker = new GraphFrontierTracker();

		// Parallel stages spawned from empty frontier
		tracker.onSpawn("sA", "stage-a"); // parents: []
		tracker.onSpawn("sB", "stage-b"); // parents: []

		// Both settle
		tracker.onSettle("sA");
		tracker.onSettle("sB");

		// Fan-in stage — frontier should now have sA and sB
		const parentsC = tracker.onSpawn("sC", "stage-c");
		assert.equal(parentsC.length, 2);
		assert.ok(parentsC.includes("sA"));
		assert.ok(parentsC.includes("sB"));
		tracker.onSettle("sC");

		const nodes = tracker.getNodes();
		assert.equal(nodes.length, 3);
	});

	test("reset clears all state", () => {
		const tracker = new GraphFrontierTracker();
		tracker.onSpawn("s1", "stage-one");
		tracker.onSettle("s1");

		tracker.reset();

		assert.equal(tracker.getNodes().length, 0);
		assert.deepEqual(tracker.getParents("s1"), []);

		// After reset, new stages are root stages
		const parents = tracker.onSpawn("s2", "stage-two");
		assert.deepEqual(parents, []);
	});

	test("getNodes returns all recorded nodes", () => {
		const tracker = new GraphFrontierTracker();
		tracker.onSpawn("s1", "alpha");
		tracker.onSettle("s1");
		tracker.onSpawn("s2", "beta");
		tracker.onSettle("s2");

		const nodes = tracker.getNodes();
		assert.equal(nodes.length, 2);
		const names = nodes.map((n) => n.name);
		assert.ok(names.includes("alpha"));
		assert.ok(names.includes("beta"));
	});
});
