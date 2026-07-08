import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { recordStageCheckpoint, stageCheckpointWithOutput } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createStore, run, test as exTest, Type, workflow } from "./executor-shared.js";

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
