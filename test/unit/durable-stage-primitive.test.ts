/**
 * Tests for the durable ctx.stage/ctx.task checkpoint recorder.
 *
 * Verifies completed stage outputs are recorded durably at the stage-end
 * lifecycle boundary and are idempotent.
 *
 * cross-ref: issue #1498 — durable stage/task checkpoints.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { recordStageCheckpoint, createDurableStagePrimitive, createDurableTaskPrimitive, createStageReplayKeyGenerator } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert as exAssert, createStore, run, test as exTest, Type, workflow } from "./executor-shared.js";

const WORKFLOW_ID = "wf-stage-test-001";

function makeStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "analyze",
    status: "completed",
    parentIds: [],
    startedAt: 1000,
    endedAt: 2000,
    result: "analysis output",
    toolEvents: [],
    ...overrides,
  };
}

describe("recordStageCheckpoint", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "stage-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
  });

  function deps() {
    return {
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
    };
  }

  test("records completed stage output", async () => {
    const recorded = await recordStageCheckpoint(deps(), makeStage());
    assert.equal(recorded, true);
    const replayKey = createStageReplayKeyGenerator(WORKFLOW_ID)("analyze", "stage-1");
    assert.equal(backend.getStageOutput(WORKFLOW_ID, replayKey), "analysis output");
  });

  test("prefers stage.replayKey when present", async () => {
    const stage = makeStage({ replayKey: "continuation:analyze:1" });
    await recordStageCheckpoint(deps(), stage);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "continuation:analyze:1"), "analysis output");
  });

  test("skips non-completed stages", async () => {
    const stage = makeStage({ status: "running" });
    assert.equal(await recordStageCheckpoint(deps(), stage), false);
  });

  test("idempotent — recording the same stage twice is a no-op", async () => {
    const d = deps();
    await recordStageCheckpoint(d, makeStage({ replayKey: "rk-1" }));
    await recordStageCheckpoint(d, makeStage({ replayKey: "rk-1", result: "DIFFERENT" }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "rk-1"), "analysis output");
    assert.equal(backend.getWorkflow(WORKFLOW_ID)!.completedCheckpoints, 1);
  });

  test("falls back to status marker when result is empty", async () => {
    const stage = makeStage({ result: undefined, replayKey: "rk-2" });
    await recordStageCheckpoint(deps(), stage);
    const output = backend.getStageOutput(WORKFLOW_ID, "rk-2");
    assert.deepEqual(output, { status: "completed", stageId: "stage-1" });
  });

  test("replayed stage invokes recordCachedStage for graph/store visibility", async () => {
    const replayKey = "stage:analyze:1";
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: WORKFLOW_ID,
      checkpointId: `stage:${replayKey}`,
      name: "analyze",
      replayKey,
      output: "cached output",
      completedAt: Date.now(),
    });
    const recorded: { name: string; replayKey: string; output: string }[] = [];
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      recordCachedStage: (name, key, output) => recorded.push({ name, replayKey: key, output: String(output) }),
      stage: () => { throw new Error("live stage should not run"); },
    });

    const ctx = stage("analyze");
    assert.equal(await ctx.prompt("ignored"), "cached output");
    assert.deepEqual(recorded, [{ name: "analyze", replayKey, output: "cached output" }]);
  });

  test("replayed task invokes recordCachedTask for graph/store visibility", async () => {
    const replayKey = "stage:task:review:1";
    const cached = { name: "review", stageName: "review", text: "cached task output" };
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: WORKFLOW_ID,
      checkpointId: `task:${replayKey}`,
      name: "review",
      replayKey,
      output: cached,
      completedAt: Date.now(),
    });
    const recorded: { name: string; replayKey: string; text: string }[] = [];
    const task = createDurableTaskPrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      recordCachedTask: (name, key, output) => recorded.push({ name, replayKey: key, text: output.text }),
      task: async () => { throw new Error("live task should not run"); },
    });

    const result = await task("review", { prompt: "ignored" });
    assert.deepEqual(result, cached);
    assert.deepEqual(recorded, [{ name: "review", replayKey, text: "cached task output" }]);
  });

  test("replay key generator namespaces by stage name + ordinal", () => {
    const gen = createStageReplayKeyGenerator(WORKFLOW_ID);
    const k1 = gen("analyze", "stage-1");
    const k2 = gen("analyze", "stage-2");
    assert.notEqual(k1, k2);
    assert.ok(k1.includes("analyze:1"));
    assert.ok(k2.includes("analyze:2"));
  });
});

describe("run durable flush", () => {
  exTest("completed stage checkpoint is awaited before next stage starts", async () => {
    class AsyncStageBackend extends InMemoryDurableBackend {
      persisted = false;
      async recordCheckpointAsync(checkpoint: import("../../packages/workflows/src/durable/types.js").DurableCheckpoint): Promise<void> {
        await Promise.resolve();
        super.recordCheckpoint(checkpoint);
        if (checkpoint.kind === "stage" && checkpoint.name === "one") this.persisted = true;
      }
    }
    const backend = new AsyncStageBackend();
    const store = createStore();
    const def = workflow({
      name: "stage-order-wf",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        await ctx.stage("one").complete("one done");
        exAssert.equal(backend.persisted, true);
        await ctx.stage("two").complete("two done");
        return { result: "ok" };
      },
    });
    const result = await run(def, {}, { runId: "wf-stage-order", store, durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });
    exAssert.equal(result.status, "completed");
  });

  exTest("cached ctx.task replay records a completed store stage", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-task-replay", name: "task", inputs: {}, createdAt: Date.now(), status: "running" });
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "wf-task-replay",
      checkpointId: "task:stage:task:cached-task:1",
      name: "cached-task",
      replayKey: "stage:task:cached-task:1",
      output: { name: "cached-task", stageName: "cached-task", text: "cached task text" },
      completedAt: Date.now(),
    });
    const store = createStore();
    const def = workflow({
      name: "task-replay-wf",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: (await ctx.task("cached-task", { prompt: "ignored" })).text }),
    });

    const result = await run(def, {}, { runId: "wf-task-replay", store, durableBackend: backend });
    const stage = store.runs()[0]?.stages[0];
    exAssert.equal(result.status, "completed");
    exAssert.equal(result.result?.["result"], "cached task text");
    exAssert.equal(stage?.name, "cached-task");
    exAssert.equal(stage?.status, "completed");
    exAssert.equal(stage?.replayed, true);
  });

  exTest("workflow completion waits for durable flush", async () => {
    class FlushBackend extends InMemoryDurableBackend {
      flushed = false;
      flushStarted = false;
      async flush(): Promise<void> {
        this.flushStarted = true;
        await Promise.resolve();
        this.flushed = true;
      }
    }
    const backend = new FlushBackend();
    backend.registerWorkflow({ workflowId: "wf-flush", name: "flush", inputs: {}, createdAt: Date.now(), status: "running" });
    backend.recordCheckpoint({ kind: "stage", workflowId: "wf-flush", checkpointId: "stage:stage:cached:1", name: "cached", replayKey: "stage:cached:1", output: "cached", completedAt: Date.now() });
    const store = createStore();
    const def = workflow({
      name: "flush-wf",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: await ctx.stage("cached").complete("cached") }),
    });

    const result = await run(def, {}, { runId: "wf-flush", store, durableBackend: backend });
    exAssert.equal(result.status, "completed");
    exAssert.equal(backend.flushStarted, true);
    exAssert.equal(backend.flushed, true);
  });

  exTest("workflow completion fails when durable flush fails", async () => {
    class FailingFlushBackend extends InMemoryDurableBackend {
      async flush(): Promise<void> { throw new Error("durable write failed"); }
    }
    const backend = new FailingFlushBackend();
    backend.registerWorkflow({ workflowId: "wf-flush-fail", name: "flush", inputs: {}, createdAt: Date.now(), status: "running" });
    backend.recordCheckpoint({ kind: "stage", workflowId: "wf-flush-fail", checkpointId: "stage:stage:cached:1", name: "cached", replayKey: "stage:cached:1", output: "cached", completedAt: Date.now() });
    const def = workflow({
      name: "flush-fail-wf",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: await ctx.stage("cached").complete("cached") }),
    });

    const result = await run(def, {}, { runId: "wf-flush-fail", store: createStore(), durableBackend: backend });
    exAssert.equal(result.status, "failed");
    exAssert.match(result.error ?? "", /durable write failed/);
  });

  exTest("ctx.chain and ctx.parallel replay completed task checkpoints", async () => {
    const backend = new InMemoryDurableBackend();
    const def = workflow({
      name: "durable-chain-parallel",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        const chain = await ctx.chain([{ name: "a", prompt: "A" }, { name: "b", prompt: "B" }]);
        const parallel = await ctx.parallel([{ name: "c", prompt: "C" }, { name: "d", prompt: "D" }], { failFast: false });
        return { result: [...chain, ...parallel].map((r) => r.text).join(",") };
      },
    });
    let prompts = 0;
    const adapters = { prompt: { prompt: async (text: string) => { prompts += 1; return `out:${text}`; } } };
    const first = await run(def, {}, { runId: "wf-chain-parallel", store: createStore(), durableBackend: backend, adapters });
    exAssert.equal(first.status, "completed");
    exAssert.equal(prompts, 4);
    const store = createStore();
    const second = await run(def, {}, { runId: "wf-chain-parallel", store, durableBackend: backend, adapters: { prompt: { prompt: async () => { throw new Error("should not rerun"); } } } });
    exAssert.equal(second.status, "completed");
    exAssert.equal(second.result?.["result"], first.result?.["result"]);
    exAssert.equal(store.runs()[0]?.stages.filter((s) => s.replayed === true).length, 4);
  });

  exTest("ctx.workflow replays completed child workflow checkpoints", async () => {
    const backend = new InMemoryDurableBackend();
    const child = workflow({
      name: "durable-child",
      description: "",
      inputs: {},
      outputs: { value: Type.String() },
      run: async (ctx) => ({ value: await ctx.stage("child-stage").complete("child-value") }),
    });
    const parent = workflow({
      name: "durable-parent",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited) throw new Error("child exited");
        return { result: childResult.outputs.value };
      },
    });
    const first = await run(parent, {}, { runId: "wf-child-parent", store: createStore(), durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });
    exAssert.equal(first.status, "completed");
    const store = createStore();
    const second = await run(parent, {}, { runId: "wf-child-parent", store, durableBackend: backend, adapters: { complete: { complete: async () => { throw new Error("child should not rerun"); } } } });
    exAssert.equal(second.status, "completed");
    exAssert.equal(second.result?.["result"], "child-value");
    exAssert.equal(store.runs()[0]?.stages.some((s) => s.name === "workflow:durable-child" && s.replayed === true), true);
  });

  exTest("terminal completed status is flushed before run returns", async () => {
    class StatusFlushBackend extends InMemoryDurableBackend {
      flushedCompleted = false;
      async flush(): Promise<void> {
        if (this.getWorkflow("wf-status-flush")?.status === "completed") this.flushedCompleted = true;
      }
    }
    const backend = new StatusFlushBackend();
    const def = workflow({
      name: "status-flush-wf",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => ({ result: await ctx.stage("one").complete("ok") }),
    });
    const result = await run(def, {}, { runId: "wf-status-flush", store: createStore(), durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });
    exAssert.equal(result.status, "completed");
    exAssert.equal(backend.flushedCompleted, true);
  });
});
