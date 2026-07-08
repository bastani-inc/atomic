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

  test("prefers completed-stage durable map key over snapshot replayKey", async () => {
    const stage = makeStage({ replayKey: "explicit:analyze:1" });
    await recordStageCheckpoint({ ...deps(), replayKeyForCompletedStage: () => "mapped:analyze:1" }, stage);
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "mapped:analyze:1"), "analysis output");
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "explicit:analyze:1"), undefined);
  });

  test("skips non-completed stages", async () => {
    const stage = makeStage({ status: "running" });
    assert.equal(await recordStageCheckpoint(deps(), stage), false);
  });

  test("preserves first replay output when later lifecycle metadata is recorded", async () => {
    const d = deps();
    await recordStageCheckpoint(d, makeStage({ replayKey: "rk-1", durationMs: 1000 }));
    await recordStageCheckpoint(d, makeStage({ replayKey: "rk-1", result: "DIFFERENT", durationMs: 2000 }));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "rk-1"), "analysis output");
  });

  test("falls back to status marker when result is empty", async () => {
    const stage = makeStage({ result: undefined, replayKey: "rk-2" });
    await recordStageCheckpoint(deps(), stage);
    const output = backend.getStageOutput(WORKFLOW_ID, "rk-2");
    assert.deepEqual(output, { status: "completed", stageId: "stage-1" });
  });

  test("schema-backed live stage records structured prompt output", async () => {
    const replayKey = "stage:structured:1";
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: () => ({
        name: "structured",
        prompt: async () => ({ summary: "ok", count: 2 }),
        complete: async () => "unused",
        steer: async () => {},
        followUp: async () => {},
        subscribe: () => () => {},
        sessionFile: undefined,
        sessionId: "s1",
        setModel: async () => {},
        setThinkingLevel: () => {},
        cycleModel: async () => undefined,
        cycleThinkingLevel: () => undefined,
        agent: undefined,
        model: undefined,
        thinkingLevel: undefined,
        messages: [],
        isStreaming: false,
        navigateTree: async () => {},
        compact: async () => {},
        abortCompaction: () => {},
        abort: async () => {},
      } as never),
    });

    const result = await stage("structured", { schema: Type.Object({ summary: Type.String(), count: Type.Number() }) }).prompt("structured");
    assert.deepEqual(result, { summary: "ok", count: 2 });
    assert.deepEqual(backend.getStageOutput(WORKFLOW_ID, replayKey), { summary: "ok", count: 2 });
  });

  test("schema-backed replay returns structured prompt output", async () => {
    const replayKey = "stage:structured:1";
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: WORKFLOW_ID,
      checkpointId: `stage:${replayKey}`,
      name: "structured",
      replayKey,
      output: { summary: "cached", count: 3 },
      completedAt: Date.now(),
    });
    const stage = createDurableStagePrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextReplayKey: () => replayKey,
      stage: () => { throw new Error("live stage should not run"); },
    });

    const result = await stage("structured", { schema: Type.Object({ summary: Type.String(), count: Type.Number() }) }).prompt("structured");
    assert.deepEqual(result, { summary: "cached", count: 3 });
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
      recordCachedStage: (name, key, checkpoint) => recorded.push({ name, replayKey: key, output: String(checkpoint.output) }),
      stage: () => { throw new Error("live stage should not run"); },
    });

    const ctx = stage("analyze");
    assert.equal(await ctx.prompt("ignored"), "cached output");
    await assert.rejects(
      () => ctx.sendUserMessage("ignored replay follow-on", { deliverAs: "steer" }),
      /live session operations are unavailable/,
    );
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
      recordCachedTask: (name, key, checkpoint) => {
        const output = checkpoint.output;
        if (typeof output !== "object" || output === null || Array.isArray(output)) return;
        const text = (output as { readonly text?: string }).text;
        if (text === undefined) return;
        recorded.push({ name, replayKey: key, text });
      },
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

  exTest("repeated ctx.workflow(child) calls replay in order without re-execution", async () => {
    const backend = new InMemoryDurableBackend();
    let childRuns = 0;
    const child = workflow({
      name: "repeated-child",
      description: "",
      inputs: {},
      outputs: { value: Type.String() },
      run: async (ctx) => { childRuns++; return { value: await ctx.stage("c").complete(`v${childRuns}`) }; },
    });
    const parent = workflow({
      name: "repeated-parent",
      description: "",
      inputs: {},
      outputs: { a: Type.String(), b: Type.String() },
      run: async (ctx) => {
        const r1 = await ctx.workflow(child);
        const r2 = await ctx.workflow(child);
        if (r1.exited || r2.exited) throw new Error("child exited");
        return { a: r1.outputs.value, b: r2.outputs.value };
      },
    });
    const store1 = createStore();
    const first = await run(parent, {}, { runId: "wf-repeated-child", store: store1, durableBackend: backend, adapters: { complete: { complete: async (text) => text } } });

    exAssert.equal(first.status, "completed");
    exAssert.equal(childRuns, 2);

    // Resume with same workflowId — both child calls should replay without re-executing.
    childRuns = 0;
    const store2 = createStore();
    const second = await run(parent, {}, { runId: "wf-repeated-child", store: store2, durableBackend: backend, adapters: { complete: { complete: async () => { throw new Error("should not re-run"); } } } });
    exAssert.equal(second.status, "completed");
    exAssert.equal(childRuns, 0);
    exAssert.equal(second.result?.["a"], first.result?.["a"]);
    exAssert.equal(second.result?.["b"], first.result?.["b"]);
  });

  exTest("ctx.exit terminal status persisted to durable metadata", async () => {
    const backend = new InMemoryDurableBackend();
    const def = workflow({
      name: "exit-wf",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => { ctx.exit({ status: "cancelled", reason: "user-abort" }); },
    });
    const result = await run(def, {}, { runId: "wf-exit-cancelled", store: createStore(), durableBackend: backend });
    exAssert.equal(result.status, "cancelled");
    const handle = backend.getWorkflow("wf-exit-cancelled");
    exAssert.equal(handle?.status, "cancelled");
  });

  exTest("ctx.exit blocked status persisted to durable metadata", async () => {
    const backend = new InMemoryDurableBackend();
    const def = workflow({
      name: "blocked-wf",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => { ctx.exit({ status: "blocked", reason: "needs-input" }); },
    });
    const result = await run(def, {}, { runId: "wf-exit-blocked", store: createStore(), durableBackend: backend });
    exAssert.equal(result.status, "blocked");
    exAssert.equal(backend.getWorkflow("wf-exit-blocked")?.status, "blocked");
  });

  exTest("child workflow run propagates custom durableBackend", async () => {
    class TrackingBackend extends InMemoryDurableBackend {
      registered: string[] = [];
      registerWorkflow(h: import("../../packages/workflows/src/durable/backend.js").WorkflowRegistrationInput): void {
        this.registered.push(h.workflowId);
        super.registerWorkflow(h);
      }
    }
    const backend = new TrackingBackend();
    const child = workflow({
      name: "backend-child",
      description: "",
      inputs: {},
      outputs: { v: Type.String() },
      run: async (ctx) => ({ v: await ctx.stage("cs").complete("cv") }),
    });
    const parent = workflow({
      name: "backend-parent",
      description: "",
      inputs: {},
      outputs: { v: Type.String() },
      run: async (ctx) => {
        const r = await ctx.workflow(child);
        if (r.exited) throw new Error("exited");
        return { v: r.outputs.v };
      },
    });
    const result = await run(parent, {}, { runId: "wf-backend-prop", store: createStore(), durableBackend: backend, adapters: { complete: { complete: async (t) => t } } });
    exAssert.equal(result.status, "completed");
    // Parent and child boundary both checkpointed on the same custom backend.
    exAssert.equal(backend.registered.includes("wf-backend-prop"), true);
    const stageCheckpoints = backend.listCheckpoints("wf-backend-prop").filter((c) => c.kind === "stage");
    exAssert.equal(stageCheckpoints.length > 0, true);
  });
});
