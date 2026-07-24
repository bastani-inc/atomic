import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

function orderedNames(snapshot: RunSnapshot): string[] {
  return [
    ...snapshot.stages.map((stage) => ({ name: stage.name, order: stage.executionOrder })),
    ...(snapshot.toolNodes ?? []).map((tool) => ({ name: tool.name, order: tool.executionOrder })),
  ].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((item) => item.name);
}

describe("ctx.tool durable graph replay", () => {
  test("fresh-store replay preserves stage → tool → stage topology and exact cached output", async () => {
    const backend = new InMemoryDurableBackend();
    const runId = "tool-mixed-replay";
    let toolCalls = 0;
    const definition = workflow({
      name: "tool-mixed-replay",
      description: "",
      inputs: {},
      outputs: { value: Type.Number(), tags: Type.Array(Type.String()) },
      run: async (ctx) => {
        await ctx.stage("before").prompt("before");
        const output = await ctx.tool("middle", {}, async () => {
          toolCalls += 1;
          return { value: 7, tags: ["raw", "raw"] };
        });
        await ctx.stage("after").prompt("after");
        return output;
      },
    });
    const adapters = { prompt: { prompt: async (text: string) => text } };

    const firstStore = createStore();
    const first = await run(definition, {}, { runId, store: firstStore, durableBackend: backend, adapters });
    assert.equal(first.status, "completed");
    assert.deepEqual(first.result, { value: 7, tags: ["raw", "raw"] });
    assert.equal(toolCalls, 1);
    const firstTool = firstStore.runs()[0]?.toolNodes?.[0];
    assert.ok(firstTool?.startedAt !== undefined);
    assert.ok(firstTool.endedAt !== undefined);

    const replayStore = createStore();
    const replay = await run(definition, {}, { runId, store: replayStore, durableBackend: backend, adapters });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.result, { value: 7, tags: ["raw", "raw"] });
    assert.equal(toolCalls, 1, "the durable callback must not rerun");

    const replayRun = replayStore.runs()[0]!;
    const [before, after] = replayRun.stages;
    const tool = replayRun.toolNodes?.[0];
    assert.deepEqual(orderedNames(replayRun), ["before", "middle", "after"]);
    assert.equal(tool?.status, "cached");
    assert.equal(tool?.id, firstTool.id);
    assert.equal(tool?.executionOrder, firstTool.executionOrder);
    assert.equal(tool?.startedAt, firstTool.startedAt);
    assert.equal(tool?.endedAt, firstTool.endedAt);
    assert.deepEqual(tool?.parentIds, [before?.id]);
    assert.deepEqual(after?.parentIds, [tool?.id]);
    const currentIds = new Set([before?.id, tool?.id, after?.id]);
    for (const node of [before, tool, after]) {
      for (const parentId of node?.parentIds ?? []) assert.equal(currentIds.has(parentId), true, `dangling parent ${parentId}`);
    }
    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRun = completedWorkflowRunSnapshots(backend, entry).find((candidate) => candidate.id === runId)!;
    const catalogTool = catalogRun.toolNodes?.[0];
    assert.deepEqual(orderedNames(catalogRun), ["before", "middle", "after"]);
    assert.deepEqual(catalogTool?.parentIds, [catalogRun.stages[0]?.id]);
    assert.deepEqual(catalogRun.stages[1]?.parentIds, [catalogTool?.id]);
    assert.equal(catalogTool?.startedAt, firstTool.startedAt);
    assert.equal(catalogTool?.endedAt, firstTool.endedAt);
  });

  test("fresh-store replay preserves concurrent tool siblings and fan-in", async () => {
    const backend = new InMemoryDurableBackend();
    const runId = "tool-concurrent-replay";
    let toolCalls = 0;
    const siblingGate = Promise.withResolvers<void>();
    const definition = workflow({
      name: "tool-concurrent-replay",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("seed").prompt("seed");
        const left = ctx.tool("left", {}, async () => {
          toolCalls += 1;
          await siblingGate.promise;
          return "left";
        });
        // The authored siblings are admitted across a microtask while the live
        // left callback is still pending. Replay must use persisted topology,
        // not synchronous cache-hit timing, to retain the sibling relation.
        await Promise.resolve();
        const right = ctx.tool("right", {}, async () => {
          toolCalls += 1;
          await siblingGate.promise;
          return "right";
        });
        siblingGate.resolve();
        await Promise.all([left, right]);
        await ctx.stage("join").prompt("join");
        return {};
      },
    });
    const adapters = { prompt: { prompt: async (text: string) => text } };

    const first = await run(definition, {}, {
      runId, store: createStore(), durableBackend: backend, adapters,
    });
    assert.equal(first.status, "completed");
    assert.equal(toolCalls, 2);

    const replayStore = createStore();
    const replay = await run(definition, {}, {
      runId, store: replayStore, durableBackend: backend, adapters,
    });
    assert.equal(replay.status, "completed");
    assert.equal(toolCalls, 2);
    const replayRun = replayStore.runs()[0]!;
    const seed = replayRun.stages.find((stage) => stage.name === "seed")!;
    const join = replayRun.stages.find((stage) => stage.name === "join")!;
    const tools = replayRun.toolNodes ?? [];
    assert.deepEqual(orderedNames(replayRun), ["seed", "left", "right", "join"]);
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((tool) => tool.parentIds), [[seed.id], [seed.id]]);
    assert.deepEqual(new Set(join.parentIds), new Set(tools.map((tool) => tool.id)));
  });

  test("tool-only child topology survives completed catalog and cached-boundary replay", async () => {
    const backend = new InMemoryDurableBackend();
    const runId = "tool-only-child-root";
    let toolCalls = 0;
    const child = workflow({
      name: "tool-only-child",
      description: "",
      inputs: {},
      outputs: { value: Type.Number() },
      run: async (ctx) => ({
        value: await ctx.tool("child-write", {}, async () => {
          toolCalls += 1;
          return 11;
        }),
      }),
    });
    const parent = workflow({
      name: "tool-only-child-root",
      description: "",
      inputs: {},
      outputs: { value: Type.Number() },
      run: async (ctx) => {
        const result = await ctx.workflow(child, { stageName: "child-boundary" });
        if (result.exited) throw new Error("child exited unexpectedly");
        return result.outputs;
      },
    });

    const liveStore = createStore();
    const live = await run(parent, {}, { runId, store: liveStore, durableBackend: backend });
    assert.equal(live.status, "completed");
    assert.deepEqual(live.result, { value: 11 });
    assert.equal(toolCalls, 1);
    const liveGraph = expandWorkflowGraph(liveStore.snapshot(), runId);
    assert.deepEqual(liveGraph.tools.map((tool) => tool.name), ["child-write"]);
    assert.deepEqual(liveGraph.stages, [], "the populated child boundary is flattened");

    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
    const catalogChild = catalogRuns.find((candidate) => candidate.parentRunId === runId);
    assert.ok(catalogChild !== undefined);
    assert.equal(catalogChild.rootRunId, runId);
    assert.deepEqual(catalogChild.toolNodes?.map((tool) => tool.name), ["child-write"]);
    const catalogGraph = expandWorkflowGraph({ runs: catalogRuns, notices: [], version: 1 }, runId);
    assert.deepEqual(catalogGraph.tools.map((tool) => tool.name), ["child-write"]);
    assert.deepEqual(catalogGraph.stages, []);

    const replayStore = createStore();
    const replay = await run(parent, {}, { runId, store: replayStore, durableBackend: backend });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.result, { value: 11 });
    assert.equal(toolCalls, 1, "cached child boundary and tool must not rerun");
    const replayGraph = expandWorkflowGraph(replayStore.snapshot(), runId);
    assert.deepEqual(replayGraph.tools.map((tool) => ({ name: tool.name, status: tool.status, attachable: tool.attachable })), [
      { name: "child-write", status: "cached", attachable: false },
    ]);
    assert.deepEqual(replayGraph.stages, []);

    const cachedChildTool = backend.listCheckpoints(runId).find(
      (checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "child-write",
    );
    assert.equal(cachedChildTool?.kind, "tool");
    if (cachedChildTool?.kind !== "tool") return;
    const partialBackend = new InMemoryDurableBackend();
    partialBackend.registerWorkflow({
      workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true,
    });
    partialBackend.recordCheckpoint(cachedChildTool);
    const partialStore = createStore();
    const partial = await run(parent, {}, { runId, store: partialStore, durableBackend: partialBackend });
    assert.equal(partial.status, "completed");
    assert.deepEqual(partial.result, { value: 11 });
    assert.equal(toolCalls, 1, "cached child tool must survive a live child/boundary continuation");
    const partialRoot = partialStore.runs().find((candidate) => candidate.id === runId)!;
    const partialBoundary = partialRoot.stages.find((stage) => stage.name === "child-boundary")!;
    const partialChild = partialStore.runs().find((candidate) => candidate.id === partialBoundary.workflowChild?.runId)!;
    assert.deepEqual(partialChild.toolNodes?.map((tool) => tool.name), ["child-write"]);
    assert.equal(partialChild.parentRunId, runId);
    assert.equal(partialChild.rootRunId, runId);
    const partialEntry = partialBackend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const partialCatalogRuns = completedWorkflowRunSnapshots(partialBackend, partialEntry);
    const partialCatalogChild = partialCatalogRuns.find((candidate) => candidate.parentRunId === runId);
    assert.equal(partialCatalogChild?.id, partialBoundary.workflowChild?.runId);
    assert.deepEqual(partialCatalogChild?.toolNodes?.map((tool) => tool.name), ["child-write"]);
    assert.deepEqual(
      expandWorkflowGraph({ runs: partialCatalogRuns, notices: [], version: 1 }, runId).tools.map((tool) => tool.name),
      ["child-write"],
    );
  });

  test("new tool topology survives DBOS flush, fresh hydration, and replay", async () => {
    const sdk = createMockSdk();
    const runId = "tool-dbos-restart";
    let toolCalls = 0;
    const definition = workflow({
      name: "tool-dbos-restart",
      description: "",
      inputs: {},
      outputs: { value: Type.Number(), labels: Type.Array(Type.String()) },
      run: async (ctx) => ctx.tool("persist-shape", { key: "same" }, async () => {
        toolCalls += 1;
        return { value: 42, labels: ["a", "a", "b"] };
      }),
    });
    const firstBackend = new DbosDurableBackend(sdk);
    const firstStore = createStore();
    const first = await run(definition, {}, { runId, store: firstStore, durableBackend: firstBackend });
    await firstBackend.flush();
    assert.equal(first.status, "completed");
    assert.equal(toolCalls, 1);
    const firstTool = firstStore.runs()[0]?.toolNodes?.[0]!;

    const freshBackend = new DbosDurableBackend(sdk);
    await freshBackend.hydrateWorkflow(runId);
    const hydrated = freshBackend.listCheckpoints(runId).find((checkpoint) => checkpoint.kind === "tool");
    assert.equal(hydrated?.kind, "tool");
    if (hydrated?.kind === "tool") {
      assert.equal(hydrated.topology?.nodeId, firstTool.id);
      assert.equal(hydrated.topology?.order, firstTool.executionOrder);
      assert.equal(hydrated.topology?.startedAt, firstTool.startedAt);
    }

    const replayStore = createStore();
    const replay = await run(definition, {}, { runId, store: replayStore, durableBackend: freshBackend });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.result, { value: 42, labels: ["a", "a", "b"] });
    assert.equal(toolCalls, 1);
    const replayTool = replayStore.runs()[0]?.toolNodes?.[0];
    assert.deepEqual({
      id: replayTool?.id, order: replayTool?.executionOrder,
      startedAt: replayTool?.startedAt, endedAt: replayTool?.endedAt,
    }, {
      id: firstTool.id, order: firstTool.executionOrder,
      startedAt: firstTool.startedAt, endedAt: firstTool.endedAt,
    });
    assert.equal(replayTool?.status, "cached");
  });
});
