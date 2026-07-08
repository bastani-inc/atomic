import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createStore, run, test as exTest, Type, workflow } from "./executor-shared.js";

test("ctx.task replay prefers task-shaped checkpoint and hydrates lifecycle metadata", async () => {
  const backend = new InMemoryDurableBackend();
  const workflowId = "wf-task-selector";
  const replayKey = "stage:task:review:1";
  backend.registerWorkflow({ workflowId, name: "task-selector", inputs: {}, createdAt: 1, status: "running" });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: `stage:${replayKey}`,
    name: "review",
    replayKey,
    output: "generic lifecycle text",
    completedAt: 20,
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    result: "generic lifecycle text",
    sessionId: "session-task",
    sessionFile: "/tmp/task.jsonl",
    model: "model-task",
  });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: `task:${replayKey}`,
    name: "review",
    replayKey,
    output: { name: "review", stageName: "review", text: "task replay text" },
    completedAt: 30,
  });
  const def = workflow({
    name: "task-selector",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => ({ result: (await ctx.task("review", { prompt: "ignored" })).text }),
  });

  const store = createStore();
  const result = await run(def, {}, {
    runId: workflowId,
    store,
    durableBackend: backend,
    adapters: { prompt: { prompt: async () => { throw new Error("task should not re-execute"); } } },
  });

  const stage = store.runs()[0]?.stages[0];
  assert.equal(result.status, "completed");
  assert.equal(result.result?.["result"], "task replay text");
  assert.equal(stage?.replayed, true);
  assert.equal(stage?.startedAt, 10);
  assert.equal(stage?.endedAt, 20);
  assert.equal(stage?.durationMs, 10);
  assert.equal(stage?.result, "generic lifecycle text");
  assert.equal(stage?.sessionId, "session-task");
  assert.equal(stage?.sessionFile, "/tmp/task.jsonl");
  assert.equal(stage?.model, "model-task");
});

exTest("ctx.workflow replay prefers child-shaped checkpoint and hydrates lifecycle metadata", async () => {
  const backend = new InMemoryDurableBackend();
  const workflowId = "wf-child-selector";
  const replayKey = "workflow:workflow:selector-child:1";
  backend.registerWorkflow({ workflowId, name: "selector-parent", inputs: {}, createdAt: 1, status: "running" });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: `stage:${replayKey}`,
    name: "workflow:selector-child",
    replayKey,
    output: { status: "completed", stageId: "boundary" },
    completedAt: 120,
    startedAt: 100,
    endedAt: 120,
    durationMs: 20,
    result: "child boundary completed",
    sessionId: "session-child",
  });
  backend.recordCheckpoint({
    kind: "stage",
    workflowId,
    checkpointId: `workflow:${replayKey}`,
    name: "workflow:selector-child",
    replayKey,
    output: { workflow: "selector-child", runId: "child-run", status: "completed", exited: false, outputs: { value: "child replay value" } },
    completedAt: 130,
  });
  const child = workflow({
    name: "selector-child",
    description: "",
    inputs: {},
    outputs: { value: Type.String() },
    run: async (ctx) => ({ value: await ctx.stage("child-stage").complete("should not run") }),
  });
  const parent = workflow({
    name: "selector-parent",
    description: "",
    inputs: {},
    outputs: { result: Type.String() },
    run: async (ctx) => {
      const childResult = await ctx.workflow(child);
      if (childResult.exited) throw new Error("child exited");
      return { result: childResult.outputs.value };
    },
  });

  const store = createStore();
  const result = await run(parent, {}, {
    runId: workflowId,
    store,
    durableBackend: backend,
    adapters: { complete: { complete: async () => { throw new Error("child should not re-execute"); } } },
  });

  const stage = store.runs()[0]?.stages[0];
  assert.equal(result.status, "completed");
  assert.equal(result.result?.["result"], "child replay value");
  assert.equal(stage?.name, "workflow:selector-child");
  assert.equal(stage?.replayed, true);
  assert.equal(stage?.startedAt, 100);
  assert.equal(stage?.endedAt, 120);
  assert.equal(stage?.durationMs, 20);
  assert.equal(stage?.result, "child boundary completed");
  assert.equal(stage?.sessionId, "session-child");
});
