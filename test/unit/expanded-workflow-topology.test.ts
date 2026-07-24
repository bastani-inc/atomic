import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  expandedStageLabel,
  expandWorkflowGraph,
  type ExpandedWorkflowStage,
} from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import type {
  RunSnapshot,
  StageSnapshot,
  StoreSnapshot,
  WorkflowChildReplaySnapshot,
  WorkflowChildRunRef,
} from "../../packages/workflows/src/shared/store-types.js";

function stage(
  id: string,
  parentIds: readonly string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    id,
    name: id,
    status: "pending",
    parentIds: [...parentIds],
    toolEvents: [],
    ...overrides,
  };
}

function childRef(runId: string, alias = "child"): WorkflowChildRunRef {
  return { alias, workflow: `${alias}-workflow`, runId };
}

function childReplay(runId: string, alias = "child"): WorkflowChildReplaySnapshot {
  return {
    ...childRef(runId, alias),
    status: "completed",
    outputs: { result: "ok" },
  };
}

function boundary(
  id: string,
  runId: string,
  parentIds: readonly string[] = [],
  status: "running" | "completed" = "running",
  alias = "child",
): StageSnapshot {
  return stage(id, parentIds, {
    status,
    ...(status === "completed"
      ? { workflowChild: childReplay(runId, alias) }
      : { workflowChildRun: childRef(runId, alias) }),
  });
}

function run(
  id: string,
  stages: StageSnapshot[],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    id,
    name: `${id}-name`,
    inputs: {},
    status: "running",
    stages,
    startedAt: 1,
    ...overrides,
  };
}

function snapshot(runs: RunSnapshot[]): StoreSnapshot {
  return { runs, notices: [], version: 1 };
}

function byId(stages: readonly ExpandedWorkflowStage[], id: string): ExpandedWorkflowStage {
  const found = stages.find((item) => item.id === id);
  assert.ok(found, `expected expanded stage ${id}`);
  return found;
}

describe("expanded nested workflow topology", () => {
  test("substitutes a valid child independent of parent stage record order", () => {
    const root = run("root", [
      stage("after", ["import"]),
      boundary("import", "child", ["before"], "completed", "nested"),
      stage("before"),
    ]);
    const child = run(
      "child",
      [stage("left"), stage("right"), stage("join", ["left", "right"])],
      { status: "completed", endedAt: 2, parentRunId: "root", parentStageId: "import", rootRunId: "root" },
    );

    const graph = expandWorkflowGraph(snapshot([root, child]), root.id);

    assert.deepEqual(graph.stages.map((item) => item.id), [
      "after",
      "child:left",
      "child:right",
      "child:join",
      "before",
    ]);
    assert.deepEqual(byId(graph.stages, "after").parentIds, ["child:join"]);
    assert.deepEqual(byId(graph.stages, "child:left").parentIds, ["before"]);
    assert.deepEqual(byId(graph.stages, "child:right").parentIds, ["before"]);
    assert.deepEqual(byId(graph.stages, "child:join").parentIds, ["child:left", "child:right"]);
    assert.deepEqual(byId(graph.stages, "child:left").workflowGraphTarget, {
      runId: "child",
      stageId: "left",
      runName: "child-name",
      depth: 1,
    });
    assert.equal(byId(graph.stages, "child:left").name, "left");
    assert.equal(expandedStageLabel(byId(graph.stages, "child:left")), "child-name:left (child/left)");
  });

  test("preserves deep sibling, parallel, and sequential ownership with repeated local ids", () => {
    const root = run("root", [
      stage("before"),
      boundary("import-a", "child-a", ["before"], "running", "repeated"),
      boundary("import-b", "child-b", ["before"], "completed", "repeated"),
      stage("import-c", ["import-a"], {
        status: "completed",
        workflowChild: {
          ...childReplay("child-c", "repeated"),
          status: "skipped",
          exited: true,
          exitReason: "intentional exit",
        },
      }),
      stage("after", ["import-b", "import-c"]),
    ]);
    const childA = run(
      "child-a",
      [
        stage("same", [], { name: "duplicate label" }),
        boundary("grand-import", "grand", ["same"], "completed", "repeated"),
        stage("end", ["grand-import"]),
      ],
      { parentRunId: "root", parentStageId: "import-a", rootRunId: "root" },
    );
    const childB = run(
      "child-b",
      [stage("same", [], { name: "duplicate label" })],
      { status: "completed", parentRunId: "root", parentStageId: "import-b", rootRunId: "root" },
    );
    const childC = run(
      "child-c",
      [stage("same", [], { name: "duplicate label" })],
      { status: "skipped", exited: true, parentRunId: "root", parentStageId: "import-c", rootRunId: "root" },
    );
    const grand = run(
      "grand",
      [stage("same", [], { name: "duplicate label" })],
      { status: "completed", parentRunId: "child-a", parentStageId: "grand-import", rootRunId: "root" },
    );

    const graph = expandWorkflowGraph(snapshot([root, childA, childB, childC, grand]), root.id);

    assert.deepEqual(graph.stages.map((item) => item.id), [
      "before",
      "child-a:same",
      "grand:same",
      "child-a:end",
      "child-b:same",
      "child-c:same",
      "after",
    ]);
    assert.deepEqual(byId(graph.stages, "child-a:same").parentIds, ["before"]);
    assert.deepEqual(byId(graph.stages, "grand:same").parentIds, ["child-a:same"]);
    assert.deepEqual(byId(graph.stages, "child-a:end").parentIds, ["grand:same"]);
    assert.deepEqual(byId(graph.stages, "child-b:same").parentIds, ["before"]);
    assert.deepEqual(byId(graph.stages, "child-c:same").parentIds, ["child-a:end"]);
    assert.deepEqual(byId(graph.stages, "after").parentIds, ["child-b:same", "child-c:same"]);
    assert.equal(byId(graph.stages, "child-a:same").name, "duplicate label");
    assert.equal(byId(graph.stages, "child-b:same").name, "duplicate label");
    assert.deepEqual(byId(graph.stages, "grand:same").workflowGraphTarget, {
      runId: "grand",
      stageId: "same",
      runName: "grand-name",
      depth: 2,
    });
    assert.equal(graph.targets.get("child-a:same")?.runId, "child-a");
    assert.equal(graph.targets.get("child-b:same")?.runId, "child-b");
    assert.equal(graph.targets.get("child-c:same")?.runId, "child-c");
  });

  test("requires a matching root owner when present but accepts legacy snapshots without one", () => {
    const root = run("root", [boundary("import", "child")]);
    const childStages = [stage("child-visible")];
    const mismatchedRoot = run("child", childStages, {
      parentRunId: "root",
      parentStageId: "import",
      rootRunId: "unrelated-root",
    });

    const mismatchedGraph = expandWorkflowGraph(snapshot([root, mismatchedRoot]), "root");
    assert.deepEqual(mismatchedGraph.stages.map((node) => node.id), ["import"]);
    assert.deepEqual(byId(mismatchedGraph.stages, "import").workflowGraphTarget, {
      runId: "root",
      stageId: "import",
      runName: "root-name",
      depth: 0,
    });

    const legacyChild = run("child", childStages, {
      parentRunId: "root",
      parentStageId: "import",
    });
    const legacyGraph = expandWorkflowGraph(snapshot([root, legacyChild]), "root");
    assert.deepEqual(legacyGraph.stages.map((node) => node.id), ["child:child-visible"]);
    assert.deepEqual(byId(legacyGraph.stages, "child:child-visible").workflowGraphTarget, {
      runId: "child",
      stageId: "child-visible",
      runName: "child-name",
      depth: 1,
    });
  });

  test("keeps one boundary summary for failed, skipped, missing, empty, stale, and recursive children", () => {
    const staleRef = childRef("child");
    const cases: Array<{ name: string; root: RunSnapshot; children: RunSnapshot[] }> = [
      {
        name: "failed boundary",
        root: run("root", [stage("before"), stage("import", ["before"], {
          status: "failed", error: "boom", workflowChildRun: staleRef,
        }), stage("after", ["import"])]),
        children: [run("child", [stage("child-visible")], {
          parentRunId: "root", parentStageId: "import", rootRunId: "root",
        })],
      },
      {
        name: "skipped boundary",
        root: run("root", [stage("before"), stage("import", ["before"], {
          status: "skipped", skippedReason: "workflow-exit", workflowChildRun: staleRef,
        }), stage("after", ["import"])]),
        children: [run("child", [stage("child-visible")], {
          parentRunId: "root", parentStageId: "import", rootRunId: "root",
        })],
      },
      {
        name: "missing child",
        root: run("root", [stage("before"), boundary("import", "missing", ["before"]), stage("after", ["import"])]),
        children: [],
      },
      {
        name: "empty child",
        root: run("root", [stage("before"), boundary("import", "child", ["before"]), stage("after", ["import"])]),
        children: [run("child", [], {
          parentRunId: "root", parentStageId: "import", rootRunId: "root",
        })],
      },
      {
        name: "mismatched parent run",
        root: run("root", [stage("before"), boundary("import", "child", ["before"]), stage("after", ["import"])]),
        children: [run("child", [stage("child-visible")], {
          parentRunId: "unrelated", parentStageId: "import", rootRunId: "unrelated",
        })],
      },
      {
        name: "mismatched parent stage",
        root: run("root", [stage("before"), boundary("import", "child", ["before"]), stage("after", ["import"])]),
        children: [run("child", [stage("child-visible")], {
          parentRunId: "root", parentStageId: "other-import", rootRunId: "root",
        })],
      },
    ];

    for (const item of cases) {
      const graph = expandWorkflowGraph(snapshot([item.root, ...item.children]), "root");
      assert.deepEqual(graph.stages.map((node) => node.id), ["before", "import", "after"], item.name);
      assert.deepEqual(byId(graph.stages, "import").parentIds, ["before"], item.name);
      assert.deepEqual(byId(graph.stages, "after").parentIds, ["import"], item.name);
      assert.deepEqual(byId(graph.stages, "import").workflowGraphTarget, {
        runId: "root", stageId: "import", runName: "root-name", depth: 0,
      }, item.name);
    }

    const recursiveRoot = run(
      "root",
      [stage("before"), boundary("import", "root", ["before"]), stage("after", ["import"])],
      { parentRunId: "root", parentStageId: "import", rootRunId: "root" },
    );
    const recursive = expandWorkflowGraph(snapshot([recursiveRoot]), "root");
    assert.deepEqual(recursive.stages.map((node) => node.id), ["before", "import", "after"]);
    assert.deepEqual(byId(recursive.stages, "after").parentIds, ["import"]);
  });

  test("leaves ordinary graph identity, ordering, duplicate edges, targets, and terminals unchanged", () => {
    const root = run("root", [
      stage("last", ["middle", "middle"]),
      stage("first"),
      stage("middle", ["first"]),
      stage("parallel", ["first"]),
    ]);

    const graph = expandWorkflowGraph(snapshot([root]), root.id);

    assert.deepEqual(graph.stages.map((node) => node.id), ["last", "first", "middle", "parallel"]);
    assert.deepEqual(graph.stages.map((node) => node.parentIds), [
      ["middle", "middle"], [], ["first"], ["first"],
    ]);
    assert.deepEqual(graph.stages.map((node) => node.workflowGraphTarget), [
      { runId: "root", stageId: "last", runName: "root-name", depth: 0 },
      { runId: "root", stageId: "first", runName: "root-name", depth: 0 },
      { runId: "root", stageId: "middle", runName: "root-name", depth: 0 },
      { runId: "root", stageId: "parallel", runName: "root-name", depth: 0 },
    ]);
    assert.deepEqual([...graph.targets.keys()], ["last", "first", "middle", "parallel"]);
  });
});
