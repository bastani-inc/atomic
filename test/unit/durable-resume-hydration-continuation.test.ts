import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { recordStageCheckpoint, stageCheckpointWithOutput } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createStore, run, test as exTest, Type, workflow } from "./executor-shared.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { completedWorkflowRunSnapshots, listCompletedFromBackend } from "../../packages/workflows/src/durable/completed-catalog.js";

function isStageCheckpoint(checkpoint: DurableCheckpoint): checkpoint is DurableStageCheckpoint {
  return checkpoint.kind === "stage";
}

function stage(overrides: Partial<StageSnapshot>): StageSnapshot {
  return {
    id: "stage-schema-meta",
    name: "structured-meta",
    status: "completed",
    parentIds: [],
    startedAt: 10,
    endedAt: 40,
    durationMs: 30,
    result: "",
    toolEvents: [],
    ...overrides,
  };
}

test("schema-backed output checkpoint merges final lifecycle metadata", async () => {
  const backend = new InMemoryDurableBackend();
  const workflowId = "wf-schema-meta";
  const replayKey = "stage:structured-meta:1";
  backend.registerWorkflow({ workflowId, name: "schema-meta", inputs: {}, createdAt: 1, status: "running" });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: `stage:${replayKey}`,
    name: "structured-meta",
    replayKey,
    output: "",
    completedAt: 100,
  });

  await recordStageCheckpoint({
    workflowId,
    backend,
    nextReplayKey: () => replayKey,
    nextCheckpointId: () => "unused",
  }, stage({ replayKey, sessionId: "schema-session", model: "schema-model" }));

  const checkpoint = stageCheckpointWithOutput(backend, workflowId, replayKey);
  assert.equal(checkpoint?.output, "");
  assert.equal(checkpoint?.startedAt, 10);
  assert.equal(checkpoint?.endedAt, 40);
  assert.equal(checkpoint?.durationMs, 30);
  assert.equal(checkpoint?.result, "");
  assert.equal(checkpoint?.sessionId, "schema-session");
  assert.equal(checkpoint?.model, "schema-model");
});

exTest("live ctx.task stage metadata converges on task durable replay key", async () => {
  const backend = new InMemoryDurableBackend();
  const def = workflow({
    name: "task-key-convergence",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      const parallel = await ctx.parallel([{ name: "completion-reviewer-1", prompt: "A" }, { name: "evidence-reviewer-1", prompt: "B" }], { failFast: false });
      return { result: parallel.map((item) => item.text).join(",") };
    },
  });

  const result = await run(def, {}, {
    runId: "wf-task-key-convergence",
    store: createStore(),
    durableBackend: backend,
    adapters: { prompt: { prompt: async (text: string) => `out:${text}` } },
  });

  assert.equal(result.status, "completed");
  const checkpoints = backend.listCheckpoints("wf-task-key-convergence").filter(isStageCheckpoint);
  const taskCheckpoint = checkpoints.find((checkpoint) => checkpoint.checkpointId === "task:stage:task:completion-reviewer-1:1");
  const lifecycleCheckpoint = checkpoints.find((checkpoint) => checkpoint.checkpointId === "stage:stage:task:completion-reviewer-1:1");
  assert.equal(taskCheckpoint?.replayKey, "stage:task:completion-reviewer-1:1");
  assert.equal(lifecycleCheckpoint?.replayKey, "stage:task:completion-reviewer-1:1");
  assert.equal(typeof lifecycleCheckpoint?.startedAt, "number");
  assert.equal(typeof lifecycleCheckpoint?.endedAt, "number");
  assert.equal(typeof lifecycleCheckpoint?.durationMs, "number");
});

exTest("cached child replay hydrates workflowChild boundary metadata", async () => {
  const backend = new InMemoryDurableBackend();
  const child = workflow({
    name: "boundary-child",
    description: "",
    inputs: {},
    outputs: { value: Type.String() },
    run: async (ctx) => ({ value: await ctx.stage("child-stage").complete("child-value") }),
  });
  const parent = workflow({
    name: "boundary-parent",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      const childResult = await ctx.workflow(child);
      if (childResult.exited) throw new Error("child exited");
      return { result: childResult.outputs.value };
    },
  });

  await run(parent, {}, { runId: "wf-boundary-child", store: createStore(), durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });
  const store = createStore();
  const second = await run(parent, {}, { runId: "wf-boundary-child", store, durableBackend: backend, adapters: { complete: { complete: async () => { throw new Error("child should not rerun"); } } } });

  assert.equal(second.status, "completed");
  const boundary = store.runs()[0]?.stages.find((item) => item.name === "workflow:boundary-child");
  assert.equal(boundary?.workflowChild?.workflow, "boundary-child");
  assert.deepEqual(boundary?.workflowChild?.outputs, { value: "child-value" });
});

exTest("fresh-store cached child replay restores nested parallel hierarchy", async () => {
  const backend = new InMemoryDurableBackend();
  const child = workflow({
    name: "parallel-child",
    description: "",
    inputs: {},
    outputs: { value: Type.String() },
    run: async (ctx) => {
      const branches = await ctx.parallel([
        { name: "left", prompt: "left" },
        { name: "right", prompt: "right" },
      ]);
      return { value: branches.map((branch) => branch.text).join("+") };
    },
  });
  const parent = workflow({
    name: "nested-parent",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      await ctx.task("before", { prompt: "before" });
      const nested = await ctx.workflow(child);
      if (nested.exited) throw new Error("child exited");
      await ctx.task("after", { prompt: nested.outputs.value });
      return { result: nested.outputs.value };
    },
  });
  const runId = "wf-nested-parallel-hydration";
  const adapters = { prompt: { prompt: async (text: string) => `out:${text}` } };
  assert.equal((await run(parent, {}, { runId, store: createStore(), durableBackend: backend, adapters })).status, "completed");

  const childTopology = backend.listCheckpoints(runId).find((checkpoint) =>
    checkpoint.kind === "stage" && checkpoint.name === "left" && checkpoint.topology?.run?.runName === "parallel-child"
  );
  assert.ok(childTopology, "child stage ownership must be persisted under the root durable run");
  const persistedRoot = backend.listCheckpoints(runId)
    .filter((checkpoint): checkpoint is DurableStageCheckpoint =>
      checkpoint.kind === "stage" && checkpoint.topology?.run?.runId === runId
    )
    .map((checkpoint) => ({ name: checkpoint.name, stageId: checkpoint.topology!.stageId, parents: checkpoint.topology!.parentIds }));
  assert.equal(persistedRoot.find((stage) => stage.name === "after")?.parents.length, 1);

  const store = createStore();
  assert.equal((await run(parent, {}, {
    runId,
    store,
    durableBackend: backend,
    adapters: { prompt: { prompt: async () => { throw new Error("cached work should not rerun"); } } },
  })).status, "completed");
  const resumedRoot = store.runs().find((candidate) => candidate.id === runId)!;
  const resumedBoundary = resumedRoot.stages.find((stage) => stage.name === "workflow:parallel-child")!;
  const persistedBoundary = persistedRoot.find((stage) => stage.name === "workflow:parallel-child")!;
  const persistedAfter = persistedRoot.find((stage) => stage.name === "after")!;
  assert.equal(persistedAfter.parents[0], persistedBoundary.stageId);

  assert.equal(resumedBoundary.replayedFromStageId, persistedBoundary.stageId);
  assert.equal(resumedRoot.stages.find((stage) => stage.name === "after")?.replayedFromStageId, persistedAfter.stageId);
  assert.deepEqual(resumedRoot.stages.find((stage) => stage.name === "after")?.parentIds, [resumedBoundary.id]);
  const graph = expandWorkflowGraph(store.snapshot(), runId);
  assert.deepEqual(graph.stages.map((stage) => stage.name), ["before", "left", "right", "after"]);
  const before = graph.stages.find((stage) => stage.name === "before")!;
  const left = graph.stages.find((stage) => stage.name === "left")!;
  const right = graph.stages.find((stage) => stage.name === "right")!;
  const after = graph.stages.find((stage) => stage.name === "after")!;
  assert.deepEqual(left.parentIds, [before.id]);
  assert.deepEqual(right.parentIds, [before.id]);
  assert.deepEqual(new Set(after.parentIds), new Set([left.id, right.id]));
});

exTest("mixed cached and live child resume remains inspectable after completion", async () => {
  const backend = new InMemoryDurableBackend();
  const child = workflow({
    name: "partial-child", description: "", inputs: {}, outputs: { value: Type.String() },
    run: async (ctx) => {
      const first = await ctx.stage("first").complete("first");
      const second = await ctx.stage("second").complete("second");
      return { value: `${first}+${second}` };
    },
  });
  const parent = workflow({
    name: "partial-parent", description: "", inputs: {}, outputs: { result: Type.String() },
    run: async (ctx) => {
      await ctx.stage("before").complete("before");
      const nested = await ctx.workflow(child);
      if (nested.exited) throw new Error("child exited");
      await ctx.stage("after").complete("after");
      return { result: nested.outputs.value };
    },
  });
  const runId = "wf-partial-child-resume";
  let failSecond = true;
  const adapters = { complete: { complete: async (text: string) => {
    if (text === "second" && failSecond) throw new Error("first session stops in child");
    return text;
  } } };
  assert.equal((await run(parent, {}, { runId, store: createStore(), durableBackend: backend, adapters })).status, "failed");
  failSecond = false;
  assert.equal((await run(parent, {}, { runId, store: createStore(), durableBackend: backend, adapters })).status, "completed");

  const entry = listCompletedFromBackend(backend).find((candidate) => candidate.workflowId === runId)!;
  const snapshots = completedWorkflowRunSnapshots(backend, entry);
  assert.ok(snapshots.length >= 2, "root and resumed child reconstruct after mixed replay/live completion");
  const graph = expandWorkflowGraph({ runs: snapshots, notices: [], version: 1 }, runId);
  assert.deepEqual(graph.stages.map((item) => item.name), ["before", "first", "second", "after"]);
});

exTest("mixed cached and live repeated child calls keep boundary replay keys in sync", async () => {
  const backend = new InMemoryDurableBackend();
  backend.registerWorkflow({ workflowId: "wf-mixed-child", name: "mixed-parent", inputs: {}, createdAt: Date.now(), status: "running" });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId: "wf-mixed-child",
    checkpointId: "workflow:workflow:workflow:mixed-child:1",
    name: "workflow:mixed-child",
    replayKey: "workflow:workflow:mixed-child:1",
    output: { workflow: "mixed-child", runId: "cached-child", status: "completed", exited: false, outputs: { value: "cached" } },
    completedAt: 10,
    result: "completed",
  });
  let childRuns = 0;
  const child = workflow({
    name: "mixed-child",
    description: "",
    inputs: {},
    outputs: { value: Type.String() },
    run: async (ctx) => {
      childRuns += 1;
      return { value: await ctx.stage("child-live").complete(`live-${childRuns}`) };
    },
  });
  const parent = workflow({
    name: "mixed-parent",
    description: "",
    inputs: {},
    outputs: { first: Type.String(), second: Type.String() },
    run: async (ctx) => {
      const first = await ctx.workflow(child);
      const second = await ctx.workflow(child);
      if (first.exited || second.exited) throw new Error("child exited");
      return { first: first.outputs.value, second: second.outputs.value };
    },
  });

  const store = createStore();
  const result = await run(parent, {}, { runId: "wf-mixed-child", store, durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, { first: "cached", second: "live-1" });
  assert.equal(childRuns, 1);
  const boundaries = store.runs()[0]?.stages.filter((item) => item.name === "workflow:mixed-child") ?? [];
  assert.deepEqual(boundaries.map((item) => item.replayKey), ["workflow:workflow:mixed-child:1", "workflow:workflow:mixed-child:2"]);
  assert.equal(backend.getStageOutput("wf-mixed-child", "workflow:workflow:mixed-child:2") !== undefined, true);
});
