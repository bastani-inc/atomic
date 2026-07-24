import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { inspectRun, statusRuns } from "../../packages/workflows/src/runs/background/status.js";

describe("ctx.tool workflow graph execution", () => {
  test("tool-only workflow completes with its declared output and one durable side effect", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    let calls = 0;
    const definition = workflow({
      name: "tool-only-graph",
      description: "",
      inputs: {},
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        await ctx.tool("irreversible", {}, async () => {
          calls += 1;
          return true;
        });
        return { done: true };
      },
    });

    const result = await run(definition, {}, { store, durableBackend: backend });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { done: true });
    assert.equal(calls, 1);
    const checkpoint = backend.listCheckpoints(result.runId).find((entry) => entry.kind === "tool" && entry.name === "irreversible");
    assert.equal(checkpoint?.kind, "tool");
    if (checkpoint?.kind === "tool") {
      assert.equal(checkpoint.topology?.nodeId, result.toolNodes?.[0]?.id);
      assert.equal(checkpoint.topology?.order, result.toolNodes?.[0]?.executionOrder);
      assert.deepEqual(checkpoint.topology?.parentIds, []);
    }
    assert.equal(backend.listCheckpoints(result.runId).filter((entry) => entry.kind === "tool" && entry.name === "irreversible").length, 1);
    assert.deepEqual(result.toolNodes?.map((node) => ({ name: node.name, status: node.status, attachable: node.attachable })), [
      { name: "irreversible", status: "completed", attachable: false },
    ]);
    const graph = expandWorkflowGraph(store.snapshot(), result.runId);
    assert.equal(graph.stages.length, 0, "stage inspection remains stage-only");
    assert.equal(graph.tools.length, 1);
    assert.equal(graph.renderStages[0]?.nodeKind, "tool");
    assert.equal(graph.renderStages[0]?.attachable, false);
    assert.equal(graph.targets.has(graph.renderStages[0]!.id), false, "tool nodes have no stage chat target");
    assert.equal(statusRuns({ store })[0]?.toolCount, 1);
    const inspected = inspectRun(result.runId, { store });
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.detail.stages.length, 0);
      assert.equal(inspected.detail.tools?.[0]?.status, "completed");
    }
  });

  test("admits a running tool node before invoking its callback and records failures", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const observedStatuses: string[] = [];
    const unsubscribe = store.subscribe((snapshot) => {
      const status = snapshot.runs[0]?.toolNodes?.[0]?.status;
      if (status !== undefined) observedStatuses.push(status);
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const definition = workflow({
      name: "tool-live-node",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.tool("fails-late", {}, async () => {
          entered.resolve();
          await release.promise;
          throw new Error("original tool failure");
        });
        return {};
      },
    });

    const pending = run(definition, {}, { store, durableBackend: backend });
    await entered.promise;
    const live = store.runs()[0]?.toolNodes?.[0];
    assert.equal(live?.status, "running");
    assert.equal(live?.name, "fails-late");
    assert.equal(live?.attachable, false);
    assert.equal(typeof live?.startedAt, "number");
    unsubscribe();
    assert.deepEqual(observedStatuses.slice(0, 2), ["pending", "running"]);
    assert.equal(live?.endedAt, undefined);
    release.resolve();

    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /original tool failure/);
    assert.equal(store.runs()[0]?.failedStageId, undefined);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
    assert.match(result.toolNodes?.[0]?.error ?? "", /original tool failure/);
    assert.equal(backend.listCheckpoints(result.runId).some((entry) => entry.kind === "tool" && entry.name === "fails-late"), false);
  });

  test("preserves tool-before, between, after, duplicate order with stage topology", async () => {
    const store = createStore();
    const definition = workflow({
      name: "mixed-tool-order",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.tool("first", {}, async () => "first");
        await ctx.stage("stage-one").prompt("one");
        await ctx.tool("middle", {}, async () => "middle");
        await ctx.stage("stage-two").prompt("two");
        await ctx.tool("last", {}, async () => "last");
        await ctx.tool("last", {}, async () => "last-again");
        return {};
      },
    });

    const result = await run(definition, {}, {
      store,
      durableBackend: new InMemoryDurableBackend(),
      adapters: { prompt: { prompt: async (text) => text } },
    });
    assert.equal(result.status, "completed");
    const snapshot = store.runs()[0]!;
    const ordered = [
      ...snapshot.stages.map((stage) => ({ name: stage.name, order: stage.executionOrder })),
      ...(snapshot.toolNodes ?? []).map((node) => ({ name: node.name, order: node.executionOrder })),
    ].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    assert.deepEqual(ordered.map((item) => item.name), ["first", "stage-one", "middle", "stage-two", "last", "last"]);
    assert.equal(snapshot.toolNodes?.[2]?.ordinal, 1);
    assert.equal(snapshot.toolNodes?.[3]?.ordinal, 2);
    assert.deepEqual(snapshot.stages[0]?.parentIds, [snapshot.toolNodes?.[0]?.id]);
    assert.deepEqual(snapshot.toolNodes?.[1]?.parentIds, [snapshot.stages[0]?.id]);
  });

  test("replays a legacy tool checkpoint without rerunning and reconstructs cached topology", async () => {
    const workflowId = "legacy-tool-only";
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId, name: "legacy-tool-only", inputs: {}, createdAt: 1, status: "paused", resumable: true });
    const { durableHash } = await import("../../packages/workflows/src/durable/backend.js");
    const argsHash = durableHash({ name: "legacy", args: {}, ordinal: 1 });
    backend.recordCheckpoint({ kind: "tool", workflowId, checkpointId: `tool:${argsHash}`, name: "legacy", argsHash, output: { raw: true }, completedAt: 2 });
    let calls = 0;
    const definition = workflow({
      name: "legacy-tool-only",
      description: "",
      inputs: {},
      outputs: { raw: Type.Boolean() },
      run: async (ctx) => {
        const value = await ctx.tool("legacy", {}, async () => {
          calls += 1;
          return { raw: false };
        });
        return value;
      },
    });

    const result = await run(definition, {}, { runId: workflowId, store: createStore(), durableBackend: backend });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { raw: true });
    assert.equal(calls, 0);
    assert.equal(result.toolNodes?.[0]?.status, "cached");
    assert.equal(result.toolNodes?.[0]?.id, `tool:${argsHash}`);
    assert.equal(result.toolNodes?.[0]?.executionOrder, 1);
  });

  test("accepts a conditional branch whose only graph execution is ctx.tool", async () => {
    const definition = workflow({
      name: "conditional-tool-only",
      description: "",
      inputs: { mutate: Type.Boolean() },
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        if (ctx.inputs.mutate) await ctx.tool("conditional", {}, async () => true);
        return { done: true };
      },
    });
    const result = await run(definition, { mutate: true }, { store: createStore(), durableBackend: new InMemoryDurableBackend() });
    assert.equal(result.status, "completed");
    assert.equal(result.toolNodes?.[0]?.name, "conditional");
  });

  test("cancellation leaves a cancelled node and no completed tool checkpoint", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const definition = workflow({
      name: "cancelled-tool",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.tool("cancel-me", {}, async () => {
          entered.resolve();
          await release.promise;
          return "late";
        });
        return {};
      },
    });
    const pending = run(definition, {}, { store, durableBackend: backend, signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("stop"));
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "killed");
    assert.equal(result.toolNodes?.[0]?.status, "cancelled");
    assert.equal(backend.listCheckpoints(result.runId).some((entry) => entry.kind === "tool" && entry.name === "cancel-me"), false);
  });
});
