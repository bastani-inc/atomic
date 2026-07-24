import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { WorkflowToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

async function assertClosedBeforeEffects(
  retainedTool: WorkflowToolPrimitive | undefined,
  store: Store,
  backend: InMemoryDurableBackend,
  runId: string,
): Promise<void> {
  assert.ok(retainedTool !== undefined);
  const beforeNodes = store.runs().flatMap((entry) => entry.toolNodes ?? []).length;
  const beforeCheckpoints = backend.listCheckpoints(runId).length;
  let callbacks = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejected = retainedTool("late", {}, async () => { callbacks += 1; return "too late"; }, {
      retriesAllowed: true, maxAttempts: 3, intervalMs: 0,
    });
    assert.equal(rejected instanceof Promise, true, "ctx.tool still returns a native promise");
    await assert.rejects(rejected, /ctx\.tool admission is closed for this run/i);
    void retainedTool("late-void", {}, async () => { callbacks += 1; return "too late"; });
    await Bun.sleep(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(callbacks, 0, "post-close callbacks and retries must never begin");
  assert.equal(store.runs().flatMap((entry) => entry.toolNodes ?? []).length, beforeNodes);
  assert.equal(backend.listCheckpoints(runId).length, beforeCheckpoints);
  assert.deepEqual(unhandled, [], "void post-close calls have an internal rejection observer");
}

describe("ctx.tool terminal admission", () => {
  test("completed publication refuses retained calls before all effects", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-completed", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("admitted", {}, async () => "done");
        return {};
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "completed");
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("ordinary failure closes admission", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-failed", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("admitted", {}, async () => "done");
        throw new Error("workflow failed after tool");
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "failed");
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("explicit exit closes admission", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-exit", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { retainedTool = ctx.tool; ctx.exit({ status: "completed" }); },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "completed");
    assert.equal(result.exited, true);
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("external cancellation closes admission after admitted tools settle", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const pending = run(workflow({
      name: "closed-tool-cancel", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("cancelled", {}, async () => { entered.resolve(); await release.promise; return "late"; });
        return {};
      },
    }), {}, { store, durableBackend: backend, signal: controller.signal });

    await entered.promise;
    controller.abort(new Error("operator cancelled"));
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "killed");
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });


  test("parent cancellation closes a retained child tool admission", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const child = workflow({
      name: "closed-child-cancel", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("child-cancelled", {}, async () => { entered.resolve(); await release.promise; return "late"; });
        return {};
      },
    });
    const parent = workflow({
      name: "closed-parent-cancel", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "child" }); return {}; },
    });
    const pending = run(parent, {}, { store, durableBackend: backend, signal: controller.signal });

    await entered.promise;
    controller.abort(new Error("cancel parent"));
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "killed");
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("active-blocked publication closes admission even though the retained run stays running", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-active-blocked", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.stage("needs-login").prompt("x");
        return {};
      },
    }), {}, {
      store,
      durableBackend: backend,
      adapters: { prompt: { prompt: async () => { throw new Error("No API key found for provider"); } } },
    });

    assert.equal(result.status, "running");
    assert.equal(store.runs()[0]?.failureDisposition, "active_blocked");
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });
  test("output validation failure closes admission", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-output", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("admitted", {}, async () => "done");
        return { value: "invalid" } as never;
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /output "value" expected number, got string/i);
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("empty-graph validation failure closes admission", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-graph", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { retainedTool = ctx.tool; return {}; },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /without creating any workflow stages or durable tool nodes/i);
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });


  test("authoritative durable failure closes admission", async () => {
    class RejectToolCheckpointBackend extends InMemoryDurableBackend {
      override async recordCheckpointAsync(): Promise<void> { throw new Error("authoritative checkpoint rejected"); }
    }
    const store = createStore();
    const backend = new RejectToolCheckpointBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    const result = await run(workflow({
      name: "closed-tool-durable", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("rejected-write", {}, async () => "done");
        return {};
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /authoritative checkpoint rejected/);
    await assertClosedBeforeEffects(retainedTool, store, backend, result.runId);
  });

  test("a rejecting durable terminal finalizer cannot leave admission open", async () => {
    class RejectTerminalFlushBackend extends InMemoryDurableBackend {
      public flushCalls = 0;
      override async flush(): Promise<void> {
        this.flushCalls += 1;
        if (this.flushCalls === 2) throw new Error("durable terminal finalizer rejected");
      }
    }
    const store = createStore();
    const backend = new RejectTerminalFlushBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    let runId = "";
    await assert.rejects(run(workflow({
      name: "closed-tool-durable-finalizer", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("admitted", {}, async () => "done");
        throw new Error("ordinary failure");
      },
    }), {}, {
      store,
      durableBackend: backend,
      onRunEnd(id) { runId = id; },
    }), /durable terminal finalizer rejected/);

    assert.equal(store.runs()[0]?.status, "failed");
    await assertClosedBeforeEffects(retainedTool, store, backend, runId);
  });
  test("a rejecting terminal callback cannot leave admission open", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let retainedTool: WorkflowToolPrimitive | undefined;
    let runId = "";
    let callbackRefusal: Promise<string> | undefined;
    let callbackCalls = 0;
    await assert.rejects(run(workflow({
      name: "closed-tool-finalizer", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        retainedTool = ctx.tool;
        await ctx.tool("admitted", {}, async () => "done");
        return {};
      },
    }), {}, {
      store,
      durableBackend: backend,
      onRunEnd(id) {
        runId = id;
        callbackRefusal = retainedTool!("during-terminal-callback", {}, async () => { callbackCalls += 1; return "late"; });
        throw new Error("terminal callback rejected");
      },
    }), /terminal callback rejected/);

    assert.equal(store.runs()[0]?.status, "completed");
    assert.ok(callbackRefusal !== undefined);
    await assert.rejects(callbackRefusal, /ctx\.tool admission is closed/);
    assert.equal(callbackCalls, 0);
    await assertClosedBeforeEffects(retainedTool, store, backend, runId);
  });
});
