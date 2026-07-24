import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { completedWorkflowRunSnapshots, listCompletedFromBackend } from "../../packages/workflows/src/durable/completed-catalog.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import type { RunSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { aggregateWorkflowRootRunId } from "../../packages/workflows/src/runs/background/workflow-lifecycle-aggregate.js";
import { createStore, run, test as executorTest, Type, workflow } from "./executor-shared.js";

function withoutParentStageId(run: RunSnapshot): Omit<RunSnapshot, "parentStageId"> {
  const { parentStageId: _parentStageId, ...rest } = run;
  return rest;
}

executorTest("fully cached repeated child replay reconciles each durable boundary", async () => {
  const backend = new InMemoryDurableBackend();
  let childExecutions = 0;
  let completeExecutions = 0;
  const child = workflow({
    name: "repeated-child",
    description: "",
    inputs: {},
    outputs: { value: Type.String() },
    run: async (ctx) => {
      childExecutions += 1;
      return { value: await ctx.stage("leaf").complete(`leaf-${childExecutions}`) };
    },
  });
  const parent = workflow({
    name: "repeated-parent",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      await ctx.stage("before").complete("before");
      const first = await ctx.workflow(child, { stageName: "first-boundary" });
      const second = await ctx.workflow(child, { stageName: "second-boundary" });
      if (first.exited || second.exited) throw new Error("unexpected child exit");
      await ctx.stage("after").complete("after");
      return { result: `${first.outputs.value}/${second.outputs.value}` };
    },
  });
  const rootId = "durable-repeated-child-root";
  const adapters = {
    complete: {
      complete: async (text: string): Promise<string> => {
        completeExecutions += 1;
        return text;
      },
    },
  };

  const initial = await run(parent, {}, {
    runId: rootId,
    store: createStore(),
    durableBackend: backend,
    adapters,
  });
  assert.equal(initial.status, "completed");
  assert.equal(childExecutions, 2);
  assert.equal(completeExecutions, 4);

  const entry = listCompletedFromBackend(backend).find((item) => item.workflowId === rootId)!;
  const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
  const catalogClone = structuredClone(catalogRuns);
  const catalogChildren = catalogRuns.filter((run) => run.parentRunId === rootId);
  assert.equal(catalogChildren.length, 2);
  assert.notEqual(catalogChildren[0]!.id, catalogChildren[1]!.id);

  childExecutions = 0;
  completeExecutions = 0;
  const replayStore = createStore();
  const emitted: StoreSnapshot[] = [];
  replayStore.subscribe((snapshot) => emitted.push(snapshot));
  const replay = await run(parent, {}, {
    runId: rootId,
    store: replayStore,
    durableBackend: backend,
    adapters: {
      complete: {
        complete: async (): Promise<string> => {
          completeExecutions += 1;
          throw new Error("fully cached replay must not execute completion work");
        },
      },
    },
  });

  assert.equal(replay.status, "completed");
  assert.equal(childExecutions, 0);
  assert.equal(completeExecutions, 0);
  assert.deepEqual(catalogRuns, catalogClone, "replay must not mutate prior catalog snapshots");

  const root = replayStore.runs().find((run) => run.id === rootId)!;
  const boundaries = root.stages.filter((stage) => stage.name.endsWith("-boundary"));
  assert.deepEqual(boundaries.map((stage) => stage.name), ["first-boundary", "second-boundary"]);
  assert.equal(boundaries.every((stage) => stage.id.startsWith("durable-")), true);
  const childIds = boundaries.map((stage) => stage.workflowChild?.runId);
  assert.equal(childIds.every((id): id is string => typeof id === "string"), true);
  assert.notEqual(childIds[0], childIds[1]);

  const replayChildren = childIds.map((id) => replayStore.runs().find((run) => run.id === id)!);
  for (const [index, replayChild] of replayChildren.entries()) {
    const boundary = boundaries[index]!;
    const catalogChild = catalogChildren.find((run) => run.id === replayChild.id)!;
    assert.equal(replayChild.status, "completed");
    assert.equal(replayChild.parentRunId, rootId);
    assert.equal(replayChild.parentStageId, boundary.id);
    assert.equal(replayChild.rootRunId, rootId);
    assert.deepEqual(withoutParentStageId(replayChild), withoutParentStageId(catalogChild));
    assert.equal(Object.getPrototypeOf(replayChild), Object.prototype);
    assert.equal(Array.isArray(replayChild.stages), true);
    assert.equal(Array.isArray(replayChild.stages[0]?.parentIds), true);
    assert.equal(Object.getPrototypeOf(replayChild.inputs), Object.prototype);
    assert.equal(Object.getPrototypeOf(boundary.workflowChild!.outputs), Object.prototype);
    assert.equal(aggregateWorkflowRootRunId(replayStore, replayChild.id), rootId);
  }

  const staleSecondParent = catalogChildren.find((run) => run.id === replayChildren[1]!.id)!.parentStageId;
  const priorSnapshot = emitted.find((snapshot) =>
    snapshot.runs.some((run) => run.id === replayChildren[1]!.id && run.parentStageId === staleSecondParent)
  );
  assert.ok(priorSnapshot, "store must have emitted the cached catalog child before reconciliation");
  assert.equal(
    priorSnapshot.runs.find((run) => run.id === replayChildren[1]!.id)?.parentStageId,
    staleSecondParent,
    "later reconciliation must not mutate an earlier StoreSnapshot clone",
  );

  const graph = expandWorkflowGraph(replayStore.snapshot(), rootId);
  assert.deepEqual(graph.stages.map((stage) => stage.name), ["before", "leaf", "leaf", "after"]);
  assert.equal(graph.stages.some((stage) => stage.name.endsWith("-boundary")), false);
  const before = graph.stages[0]!;
  const firstLeaf = graph.stages[1]!;
  const secondLeaf = graph.stages[2]!;
  const after = graph.stages[3]!;
  const firstLeafId = `${replayChildren[0]!.id}:${replayChildren[0]!.stages[0]!.id}`;
  const secondLeafId = `${replayChildren[1]!.id}:${replayChildren[1]!.stages[0]!.id}`;
  assert.equal(firstLeaf.id, firstLeafId);
  assert.equal(secondLeaf.id, secondLeafId);
  assert.notEqual(firstLeaf.id, secondLeaf.id);
  assert.deepEqual(firstLeaf.parentIds, [before.id]);
  assert.deepEqual(secondLeaf.parentIds, [firstLeaf.id]);
  assert.deepEqual(after.parentIds, [secondLeaf.id]);
  assert.deepEqual(firstLeaf.workflowGraphTarget, {
    runId: replayChildren[0]!.id,
    stageId: replayChildren[0]!.stages[0]!.id,
    runName: "repeated-child",
    depth: 1,
  });
  assert.deepEqual(secondLeaf.workflowGraphTarget, {
    runId: replayChildren[1]!.id,
    stageId: replayChildren[1]!.stages[0]!.id,
    runName: "repeated-child",
    depth: 1,
  });
  assert.deepEqual(graph.targets.get(firstLeafId), firstLeaf.workflowGraphTarget);
  assert.deepEqual(graph.targets.get(secondLeafId), secondLeaf.workflowGraphTarget);
});

