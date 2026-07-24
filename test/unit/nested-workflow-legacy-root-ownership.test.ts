import { test } from "bun:test";
import assert from "node:assert/strict";
import { aggregateWorkflowRootRunId } from "../../packages/workflows/src/runs/background/workflow-lifecycle-aggregate.js";
import {
  expandWorkflowGraph,
  type ExpandedWorkflowStage,
} from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { reciprocalWorkflowRootRunId } from "../../packages/workflows/src/shared/workflow-run-ownership.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
  RunSnapshot,
  StageSnapshot,
  StoreSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";

function stage(
  id: string,
  parentIds: readonly string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    id,
    name: id,
    status: "completed",
    parentIds: [...parentIds],
    toolEvents: [],
    ...overrides,
  };
}

function boundary(
  id: string,
  childRunId: string,
  parentIds: readonly string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return stage(id, parentIds, {
    workflowChild: {
      alias: childRunId,
      workflow: `${childRunId}-workflow`,
      runId: childRunId,
      status: "completed",
      outputs: {},
    },
    ...overrides,
  });
}

function run(
  id: string,
  stages: readonly StageSnapshot[],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    id,
    name: `${id}-name`,
    inputs: {},
    status: "completed",
    stages: [...stages],
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    ...overrides,
  };
}

function snapshot(runs: readonly RunSnapshot[]): StoreSnapshot {
  return { runs: [...runs], notices: [], version: 1 };
}

function graphStage(stages: readonly ExpandedWorkflowStage[], id: string): ExpandedWorkflowStage {
  const found = stages.find((item) => item.id === id);
  assert.ok(found, `expected graph stage ${id}`);
  return found;
}

function aggregateRoot(runs: readonly RunSnapshot[], runId: string): string {
  const store = createStore();
  for (const item of runs) store.recordRunStart(item);
  return aggregateWorkflowRootRunId(store, runId);
}

function mixedLegacyHierarchy(overrides: {
  readonly rootRootRunId?: string;
  readonly middleRootRunId?: string;
  readonly grandRootRunId?: string;
} = {}): readonly RunSnapshot[] {
  const root = run("root", [
    stage("before"),
    boundary("middle-boundary", "middle", ["before"]),
    stage("after", ["middle-boundary"]),
  ], {
    ...(overrides.rootRootRunId !== undefined ? { rootRunId: overrides.rootRootRunId } : {}),
  });
  const middle = run("middle", [
    stage("middle-before"),
    boundary("grand-boundary", "grand", ["middle-before"]),
    stage("middle-after", ["grand-boundary"]),
  ], {
    parentRunId: "root",
    parentStageId: "middle-boundary",
    ...(overrides.middleRootRunId !== undefined ? { rootRunId: overrides.middleRootRunId } : {}),
  });
  const grand = run("grand", [stage("leaf", [], { name: " leaf raw ", parentIds: [] })], {
    parentRunId: "middle",
    parentStageId: "grand-boundary",
    ...(overrides.grandRootRunId !== undefined ? { rootRunId: overrides.grandRootRunId } : {}),
  });
  return [root, middle, grand];
}

test("complete reciprocal ancestry derives omitted intermediate root for graph and routing", () => {
  const runs = mixedLegacyHierarchy({ rootRootRunId: "root", grandRootRunId: "root" });
  const graph = expandWorkflowGraph(snapshot(runs), "root");

  assert.deepEqual(graph.stages.map((item) => item.id), [
    "before",
    "middle:middle-before",
    "grand:leaf",
    "middle:middle-after",
    "after",
  ]);
  assert.deepEqual(graph.stages.map((item) => item.parentIds), [
    [],
    ["before"],
    ["middle:middle-before"],
    ["grand:leaf"],
    ["middle:middle-after"],
  ]);
  assert.deepEqual(graph.stages.map((item) => item.workflowGraphTarget), [
    { runId: "root", stageId: "before", runName: "root-name", depth: 0 },
    { runId: "middle", stageId: "middle-before", runName: "middle-name", depth: 1 },
    { runId: "grand", stageId: "leaf", runName: "grand-name", depth: 2 },
    { runId: "middle", stageId: "middle-after", runName: "middle-name", depth: 1 },
    { runId: "root", stageId: "after", runName: "root-name", depth: 0 },
  ]);
  assert.deepEqual(
    [...graph.targets.entries()],
    graph.stages.map((item) => [item.id, item.workflowGraphTarget]),
  );
  assert.equal(graph.stages.some((item) => item.id.includes("boundary")), false);
  const leaf = graphStage(graph.stages, "grand:leaf");
  assert.equal(leaf.name, " leaf raw ");
  assert.equal(Array.isArray(leaf.parentIds), true);
  assert.deepEqual(leaf.workflowGraphTarget, {
    runId: "grand",
    stageId: "leaf",
    runName: "grand-name",
    depth: 2,
  });
  assert.deepEqual(graph.targets.get("grand:leaf"), leaf.workflowGraphTarget);
  assert.equal(aggregateRoot(runs, "middle"), "root");
  assert.equal(aggregateRoot(runs, "grand"), "root");
});

test("complete ancestry accepts omitted roots and mixed correct roots", () => {
  const variants = [
    mixedLegacyHierarchy(),
    mixedLegacyHierarchy({ middleRootRunId: "root" }),
    mixedLegacyHierarchy({ rootRootRunId: "root", grandRootRunId: "root" }),
  ];

  for (const runs of variants) {
    const graph = expandWorkflowGraph(snapshot(runs), "root");
    assert.deepEqual(graph.stages.map((item) => item.id), [
      "before",
      "middle:middle-before",
      "grand:leaf",
      "middle:middle-after",
      "after",
    ]);
    assert.equal(aggregateRoot(runs, "middle"), "root");
    assert.equal(aggregateRoot(runs, "grand"), "root");
  }
});

test("explicit root conflicts fail closed at every lineage level", () => {
  const cases = [
    {
      name: "grandchild names immediate parent",
      runs: mixedLegacyHierarchy({ rootRootRunId: "root", grandRootRunId: "middle" }),
      expectedGraph: ["before", "middle:middle-before", "middle:grand-boundary", "middle:middle-after", "after"],
    },
    {
      name: "intermediate conflicts with top",
      runs: mixedLegacyHierarchy({ rootRootRunId: "root", middleRootRunId: "other-root", grandRootRunId: "root" }),
      expectedGraph: ["before", "middle-boundary", "after"],
    },
    {
      name: "top snapshot names another root",
      runs: mixedLegacyHierarchy({ rootRootRunId: "other-root", grandRootRunId: "root" }),
      expectedGraph: ["before", "middle-boundary", "after"],
    },
    {
      name: "grandchild conflicts with derived top",
      runs: mixedLegacyHierarchy({ rootRootRunId: "root", grandRootRunId: "other-root" }),
      expectedGraph: ["before", "middle:middle-before", "middle:grand-boundary", "middle:middle-after", "after"],
    },
  ];

  for (const item of cases) {
    const graph = expandWorkflowGraph(snapshot(item.runs), "root");
    assert.deepEqual(graph.stages.map((stage) => stage.id), item.expectedGraph, item.name);
    assert.equal(aggregateRoot(item.runs, "grand"), "grand", item.name);
  }
});

test("incomplete stale and cyclic ancestry returns no owner without throwing", () => {
  const validRoot = run("root", [boundary("middle-boundary", "middle")]);
  const validMiddle = run("middle", [stage("leaf")], {
    parentRunId: "root",
    parentStageId: "middle-boundary",
  });
  const cases: ReadonlyArray<{ readonly name: string; readonly runs: readonly RunSnapshot[]; readonly runId: string }> = [
    { name: "missing parent", runs: [validMiddle], runId: "middle" },
    {
      name: "missing parent stage",
      runs: [run("root", []), validMiddle],
      runId: "middle",
    },
    {
      name: "partial parent pair",
      runs: [validRoot, run("middle", [stage("leaf")], { parentRunId: "root" })],
      runId: "middle",
    },
    {
      name: "stale boundary claim",
      runs: [run("root", [boundary("middle-boundary", "other")]), validMiddle],
      runId: "middle",
    },
    {
      name: "failed boundary",
      runs: [run("root", [boundary("middle-boundary", "middle", [], { status: "failed" })]), validMiddle],
      runId: "middle",
    },
    {
      name: "skipped boundary",
      runs: [run("root", [boundary("middle-boundary", "middle", [], { status: "skipped" })]), validMiddle],
      runId: "middle",
    },
    {
      name: "completed replay claim conflicts",
      runs: [run("root", [boundary("middle-boundary", "other", [], {
        workflowChildRun: { alias: "middle", workflow: "middle-workflow", runId: "middle" },
      })]), validMiddle],
      runId: "middle",
    },
    {
      name: "active live claim conflicts",
      runs: [run("root", [stage("middle-boundary", [], {
        status: "running",
        workflowChild: {
          alias: "middle", workflow: "middle-workflow", runId: "middle",
          status: "completed", outputs: {},
        },
        workflowChildRun: { alias: "other", workflow: "other-workflow", runId: "other" },
      })]), validMiddle],
      runId: "middle",
    },
    {
      name: "requested run missing",
      runs: [validRoot],
      runId: "missing",
    },
    {
      name: "self cycle",
      runs: [run("self", [boundary("to-self", "self")], {
        parentRunId: "self", parentStageId: "to-self",
      })],
      runId: "self",
    },
    {
      name: "three-run cycle",
      runs: [
        run("a", [boundary("a-to-b", "b")], { parentRunId: "c", parentStageId: "c-to-a" }),
        run("b", [boundary("b-to-c", "c")], { parentRunId: "a", parentStageId: "a-to-b" }),
        run("c", [boundary("c-to-a", "a")], { parentRunId: "b", parentStageId: "b-to-c" }),
      ],
      runId: "a",
    },
    {
      name: "cycle",
      runs: [
        run("a", [boundary("to-b", "b")], { parentRunId: "b", parentStageId: "to-a" }),
        run("b", [boundary("to-a", "a")], { parentRunId: "a", parentStageId: "to-b" }),
      ],
      runId: "a",
    },
  ];

  for (const item of cases) {
    const runById = new Map(item.runs.map((candidate) => [candidate.id, candidate]));
    assert.doesNotThrow(() => reciprocalWorkflowRootRunId(runById, item.runId), item.name);
    assert.equal(reciprocalWorkflowRootRunId(runById, item.runId), undefined, item.name);
    assert.equal(aggregateRoot(item.runs, item.runId), item.runId, item.name);
  }

  const completedPrecedenceRoot = run("root", [boundary("middle-boundary", "middle", [], {
    workflowChildRun: { alias: "other", workflow: "other-workflow", runId: "other" },
  })]);
  const completedMap = new Map([completedPrecedenceRoot, validMiddle].map((candidate) => [candidate.id, candidate]));
  assert.equal(reciprocalWorkflowRootRunId(completedMap, "middle"), "root");
  const activePrecedenceRoot = run("root", [stage("middle-boundary", [], {
    status: "running",
    workflowChild: {
      alias: "other", workflow: "other-workflow", runId: "other",
      status: "completed", outputs: {},
    },
    workflowChildRun: { alias: "middle", workflow: "middle-workflow", runId: "middle" },
  })]);
  const activeMap = new Map([activePrecedenceRoot, validMiddle].map((candidate) => [candidate.id, candidate]));
  assert.equal(reciprocalWorkflowRootRunId(activeMap, "middle"), "root");
});

test("graph expansion from an orphaned rootless nested run keeps its boundary", () => {
  const [, middle, grand] = mixedLegacyHierarchy({ grandRootRunId: "root" });
  const graph = expandWorkflowGraph(snapshot([middle!, grand!]), "middle");

  assert.deepEqual(graph.stages.map((item) => item.id), [
    "middle-before",
    "grand-boundary",
    "middle-after",
  ]);
  assert.deepEqual(graphStage(graph.stages, "middle-after").parentIds, ["grand-boundary"]);
  assert.equal(aggregateRoot([middle!, grand!], "grand"), "grand");
});

test("only the child's exact reciprocal boundary can own a duplicate claim", () => {
  const root = run("root", [
    boundary("owner", "middle"),
    boundary("duplicate", "middle"),
  ]);
  const middle = run("middle", [stage("leaf")], {
    parentRunId: "root",
    parentStageId: "owner",
  });
  const graph = expandWorkflowGraph(snapshot([root, middle]), "root");

  assert.deepEqual(graph.stages.map((item) => item.id), ["middle:leaf", "duplicate"]);
  assert.equal(aggregateRoot([root, middle], "middle"), "root");
  assert.deepEqual(graphStage(graph.stages, "duplicate").workflowGraphTarget, {
    runId: "root",
    stageId: "duplicate",
    runName: "root-name",
    depth: 0,
  });
});

test("ordinary top-level graphs preserve duplicate edges and plain targets", () => {
  const root = run("root", [
    stage("first", [], { name: " raw first " }),
    stage("last", ["first", "first"]),
  ]);
  const graph = expandWorkflowGraph(snapshot([root]), "root");

  assert.deepEqual(graph.stages.map((item) => item.id), ["first", "last"]);
  assert.deepEqual(graphStage(graph.stages, "last").parentIds, ["first", "first"]);
  assert.equal(Array.isArray(graphStage(graph.stages, "last").parentIds), true);
  assert.equal(graphStage(graph.stages, "first").name, " raw first ");
  assert.deepEqual(graph.targets.get("last"), {
    runId: "root",
    stageId: "last",
    runName: "root-name",
    depth: 0,
  });
});
