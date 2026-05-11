/**
 * Phase C tests — GraphFrontierTracker
 * Covers: sequential, parallel (Promise.all-like), fan-in parent inference, reset.
 */
import { test, expect, describe } from "bun:test";
import { GraphFrontierTracker } from "../../src/runs/shared/graph-inference.js";

describe("GraphFrontierTracker — Phase C", () => {
  // -------------------------------------------------------------------------
  // Sequential
  // -------------------------------------------------------------------------

  describe("sequential execution", () => {
    test("first stage has no parents", () => {
      const tracker = new GraphFrontierTracker();
      const parents = tracker.onSpawn("s1", "first");
      expect(parents).toEqual([]);
    });

    test("each awaited stage depends on the previous settled stage", () => {
      const tracker = new GraphFrontierTracker();

      tracker.onSpawn("s1", "stage-one");
      tracker.onSettle("s1");

      const p2 = tracker.onSpawn("s2", "stage-two");
      expect(p2).toEqual(["s1"]);
      tracker.onSettle("s2");

      const p3 = tracker.onSpawn("s3", "stage-three");
      expect(p3).toEqual(["s2"]);
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

      expect(tracker.getParents("a")).toEqual([]);
      expect(tracker.getParents("b")).toEqual(["a"]);
      expect(tracker.getParents("c")).toEqual(["b"]);
    });

    test("getNodes reflects correct parentIds after sequential run", () => {
      const tracker = new GraphFrontierTracker();

      tracker.onSpawn("n1", "node-one");
      tracker.onSettle("n1");
      tracker.onSpawn("n2", "node-two");
      tracker.onSettle("n2");

      const nodes = tracker.getNodes();
      expect(nodes).toHaveLength(2);

      const n2 = nodes.find((n) => n.id === "n2");
      expect(n2?.parentIds).toEqual(["n1"]);
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

      expect(pA).toEqual(["root"]);
      expect(pB).toEqual(["root"]);
    });

    test("parallel root stages: both have empty parents", () => {
      const tracker = new GraphFrontierTracker();

      const pA = tracker.onSpawn("pA", "parallel-a");
      const pB = tracker.onSpawn("pB", "parallel-b");

      expect(pA).toEqual([]);
      expect(pB).toEqual([]);
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

      expect(pA).toEqual(["r"]);
      expect(pB).toEqual(["r"]);
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
      expect(fanInParents).toHaveLength(2);
      expect(fanInParents).toContain("pA");
      expect(fanInParents).toContain("pB");
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
      expect(zNode?.parentIds).toHaveLength(2);
      expect(zNode?.parentIds).toContain("x");
      expect(zNode?.parentIds).toContain("y");
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
      expect(postParents).toEqual(["fi"]);
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

      expect(tracker.getNodes()).toHaveLength(0);
      expect(tracker.getParents("s1")).toEqual([]);
    });

    test("after reset, new stages are root stages (empty frontier)", () => {
      const tracker = new GraphFrontierTracker();

      tracker.onSpawn("old", "old");
      tracker.onSettle("old");
      tracker.reset();

      const parents = tracker.onSpawn("fresh", "fresh");
      expect(parents).toEqual([]);
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

      expect(tracker.getParents("a")).toEqual([]);
      expect(tracker.getParents("b")).toEqual(["a"]);
      expect(tracker.getNodes()).toHaveLength(2);
    });
  });
});
