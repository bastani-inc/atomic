import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

describe("legacy scoped child tool topology migration", () => {
  test("replays without callback and appends current child ownership", async () => {
    const runId = "legacy-child-tool-root";
    let callbackCalls = 0;
    const child = workflow({
      name: "legacy-child-tool", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => ({
        value: await ctx.tool("legacy-child-write", {}, async () => { callbackCalls += 1; return 17; }),
      }),
    });
    const parent = workflow({
      name: "legacy-child-tool-root", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => {
        const result = await ctx.workflow(child, { stageName: "child-boundary" });
        if (result.exited) throw new Error("unexpected child exit");
        return result.outputs;
      },
    });

    const seedBackend = new InMemoryDurableBackend();
    await run(parent, {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.name === "legacy-child-write",
    );
    callbackCalls = 0;
    assert.ok(seeded !== undefined);
    const legacy: DurableToolCheckpoint = {
      kind: "tool",
      workflowId: runId,
      checkpointId: seeded.checkpointId,
      name: seeded.name,
      argsHash: seeded.argsHash,
      output: seeded.output,
      completedAt: 1,
    };

    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true,
    });
    backend.recordCheckpoint(legacy);
    const store = createStore();
    const result = await run(parent, {}, { runId, store, durableBackend: backend });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { value: 17 });
    assert.equal(callbackCalls, 0, "legacy replay must not call the child tool again");
    const boundary = store.runs().find((candidate) => candidate.id === runId)?.stages[0];
    const childRun = store.runs().find((candidate) => candidate.id === boundary?.workflowChild?.runId);
    assert.equal(childRun?.toolNodes?.[0]?.status, "cached");
    const logicalRecords = backend.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === legacy.argsHash,
    );
    assert.equal(logicalRecords.length, 2, "migration appends instead of replacing the legacy checkpoint");
    const migrated = logicalRecords.at(-1);
    assert.equal(migrated?.topology?.run?.runId, childRun?.id);
    assert.equal(migrated?.name, "legacy-child-write");
    assert.equal(migrated?.topology?.endedAt, legacy.completedAt);
    assert.equal(migrated?.topology?.run?.parentRunId, runId);
    assert.equal(migrated?.topology?.run?.parentStageId, boundary?.id);
    assert.equal(migrated?.output, legacy.output);

    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
    const catalogChild = catalogRuns.find((candidate) => candidate.parentRunId === runId);
    assert.equal(catalogChild?.id, childRun?.id);
    assert.deepEqual(catalogChild?.toolNodes?.map((node) => node.name), ["legacy-child-write"]);
    assert.deepEqual(
      expandWorkflowGraph({ runs: catalogRuns, notices: [], version: 1 }, runId).tools.map((node) => node.name),
      ["legacy-child-write"],
    );
  });

  test("migrated child tool remains the parent of a following stage", async () => {
    const runId = "legacy-child-tool-stage-root";
    let callbackCalls = 0;
    const seedChild = workflow({
      name: "legacy-mixed-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.tool("legacy-before-stage", {}, async () => { callbackCalls += 1; return "cached"; }); return {}; },
    });
    const makeParent = (child: typeof seedChild) => workflow({
      name: "legacy-child-tool-stage-root", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "child-boundary" }); return {}; },
    });
    const seedBackend = new InMemoryDurableBackend();
    await run(makeParent(seedChild), {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.name === "legacy-before-stage",
    )!;
    callbackCalls = 0;
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: runId, name: "legacy-child-tool-stage-root", inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: seeded.checkpointId, name: seeded.name,
      argsHash: seeded.argsHash, output: seeded.output, completedAt: 1,
    });
    const replayChild = workflow({
      name: "legacy-mixed-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("legacy-before-stage", {}, async () => { callbackCalls += 1; return "unexpected"; });
        await ctx.stage("after-legacy-tool").prompt("continue");
        return {};
      },
    });
    const store = createStore();
    const result = await run(makeParent(replayChild as typeof seedChild), {}, {
      runId, store, durableBackend: backend, adapters: { prompt: { prompt: async () => "done" } },
    });

    assert.equal(result.status, "completed");
    assert.equal(callbackCalls, 0);
    const childRun = store.runs().find((candidate) => candidate.parentRunId === runId)!;
    const childTool = childRun.toolNodes?.[0]!;
    const childStage = childRun.stages[0]!;
    assert.equal(childTool.status, "cached");
    assert.deepEqual(childStage.parentIds, [childTool.id]);
    const records = backend.listCheckpoints(runId);
    const migrated = records.filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    ).at(-1)!;
    const stageCheckpoint = records.find((checkpoint) => checkpoint.kind === "stage" && checkpoint.name === "after-legacy-tool");
    assert.equal(stageCheckpoint?.kind, "stage");
    assert.equal(migrated.topology?.run?.runId, childRun.id);
    if (stageCheckpoint?.kind !== "stage") return;
    assert.equal(stageCheckpoint.topology?.run?.runId, childRun.id);
    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
    const ids = new Set(catalogRuns.flatMap((snapshot) => [
      ...snapshot.stages.map((stage) => stage.id),
      ...(snapshot.toolNodes ?? []).map((node) => node.id),
    ]));
    for (const snapshot of catalogRuns) {
      for (const node of [...snapshot.stages, ...(snapshot.toolNodes ?? [])]) {
        for (const parentId of node.parentIds) assert.equal(ids.has(parentId), true, `dangling parent ${parentId}`);
      }
    }
  });

  test("migrates topology-less tools into the current nested grandchild run", async () => {
    const runId = "legacy-nested-root";
    let callbackCalls = 0;
    const grandchild = workflow({
      name: "legacy-grandchild", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.tool("nested-write", {}, async () => { callbackCalls += 1; return "nested"; }); return {}; },
    });
    const child = workflow({
      name: "legacy-parent-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(grandchild, { stageName: "grandchild-boundary" }); return {}; },
    });
    const parent = workflow({
      name: "legacy-nested-root", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "child-boundary" }); return {}; },
    });
    const seedBackend = new InMemoryDurableBackend();
    await run(parent, {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.name === "nested-write",
    )!;
    callbackCalls = 0;
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: seeded.checkpointId, name: seeded.name,
      argsHash: seeded.argsHash, output: seeded.output, completedAt: 1,
    });
    const store = createStore();
    const result = await run(parent, {}, { runId, store, durableBackend: backend });

    assert.equal(result.status, "completed");
    assert.equal(callbackCalls, 0);
    const childRun = store.runs().find((candidate) => candidate.parentRunId === runId)!;
    const grandchildRun = store.runs().find((candidate) => candidate.parentRunId === childRun.id)!;
    assert.equal(grandchildRun.rootRunId, runId);
    assert.equal(grandchildRun.toolNodes?.[0]?.status, "cached");
    const migrated = backend.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    ).at(-1)!;
    assert.equal(migrated.topology?.run?.runId, grandchildRun.id);
    assert.equal(migrated.topology?.run?.parentRunId, childRun.id);
    assert.equal(migrated.topology?.run?.rootRunId, runId);
    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
    assert.equal(catalogRuns.find((candidate) => candidate.id === grandchildRun.id)?.toolNodes?.[0]?.name, "nested-write");
    assert.equal(expandWorkflowGraph({ runs: catalogRuns, notices: [], version: 1 }, runId).tools.filter((node) => node.name === "nested-write").length, 1);
  });

  test("keeps topology-less root fallback unchanged and preserves the reserved public name", async () => {
    const runId = "legacy-root-fallback";
    let callbackCalls = 0;
    const definition = workflow({
      name: "legacy-root-fallback", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => ({
        value: await ctx.tool("workflow-run-timing", { public: true }, async () => { callbackCalls += 1; return 23; }),
      }),
    });
    const seedBackend = new InMemoryDurableBackend();
    await run(definition, {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash !== "workflow-run-timing",
    )!;
    callbackCalls = 0;
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: runId, name: definition.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: seeded.checkpointId, name: seeded.name,
      argsHash: seeded.argsHash, output: seeded.output, completedAt: 1,
    });

    const result = await run(definition, {}, { runId, store: createStore(), durableBackend: backend });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { value: 23 });
    assert.equal(callbackCalls, 0);
    const logicalRecords = backend.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    );
    assert.equal(logicalRecords.length, 1, "legacy root replay must not invent topology metadata");
    assert.equal(logicalRecords[0]?.topology, undefined);
    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRoot = completedWorkflowRunSnapshots(backend, entry).find((candidate) => candidate.id === runId)!;
    assert.deepEqual(catalogRoot.toolNodes?.map((node) => node.name), ["workflow-run-timing"]);
  });

  test("repeated interrupted child replays keep the latest ownership without duplicates", async () => {
    const runId = "legacy-repeated-root";
    let callbackCalls = 0;
    let shouldFail = false;
    const child = workflow({
      name: "legacy-repeated-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("repeated-write", {}, async () => { callbackCalls += 1; return "cached"; });
        if (shouldFail) throw new Error("simulated child interruption");
        return {};
      },
    });
    const parent = workflow({
      name: "legacy-repeated-root", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "child-boundary" }); return {}; },
    });
    const seedBackend = new InMemoryDurableBackend();
    await run(parent, {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.name === "repeated-write",
    )!;
    const scopePrefix = seeded.argsHash.slice(0, seeded.argsHash.lastIndexOf(":"));
    callbackCalls = 0;
    shouldFail = true;
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: seeded.checkpointId, name: seeded.name,
      argsHash: seeded.argsHash, output: seeded.output, completedAt: 1,
    });
    const attemptRunIds: string[] = [];
    for (const attempt of [1, 2]) {
      const attemptRunId = `legacy-repeated-child-${attempt}`;
      attemptRunIds.push(attemptRunId);
      const result = await run(child, {}, {
        runId: attemptRunId,
        store: createStore(),
        durableBackend: backend,
        durableScope: { rootWorkflowId: runId, scopePrefix },
        parentRun: { runId, stageId: `attempt-boundary-${attempt}`, rootRunId: runId },
      });
      assert.equal(result.status, "failed");
      assert.equal(result.toolNodes?.[0]?.status, "cached");
      assert.equal(callbackCalls, 0);
    }

    shouldFail = false;
    const finalStore = createStore();
    const final = await run(parent, {}, { runId, store: finalStore, durableBackend: backend });
    assert.equal(final.status, "completed");
    assert.equal(callbackCalls, 0);
    const finalChild = finalStore.runs().find((candidate) => candidate.parentRunId === runId)!;
    assert.equal(attemptRunIds.includes(finalChild.id), false);
    const logicalRecords = backend.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    );
    assert.equal(logicalRecords.length, 4);
    assert.equal(logicalRecords.at(-1)?.topology?.run?.runId, finalChild.id);
    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(backend, entry);
    assert.equal(catalogRuns.find((candidate) => candidate.id === finalChild.id)?.toolNodes?.length, 1);
    assert.equal(expandWorkflowGraph({ runs: catalogRuns, notices: [], version: 1 }, runId).tools.filter((node) => node.name === "repeated-write").length, 1);
  });

  test("DBOS hydration preserves additive child migration and replay idempotency", async () => {
    const runId = "legacy-child-dbos";
    let callbackCalls = 0;
    const child = workflow({
      name: "legacy-dbos-child", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => ({
        value: await ctx.tool("dbos-legacy-write", {}, async () => { callbackCalls += 1; return 31; }),
      }),
    });
    const parent = workflow({
      name: "legacy-child-dbos", description: "", inputs: {}, outputs: { value: Type.Number() },
      run: async (ctx) => {
        const result = await ctx.workflow(child, { stageName: "child-boundary" });
        if (result.exited) throw new Error("unexpected child exit");
        return result.outputs;
      },
    });
    const seedBackend = new InMemoryDurableBackend();
    await run(parent, {}, { runId, store: createStore(), durableBackend: seedBackend });
    const seeded = seedBackend.listCheckpoints(runId).find(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.name === "dbos-legacy-write",
    )!;
    callbackCalls = 0;
    const sdk = createMockSdk();
    const writer = new DbosDurableBackend(sdk);
    writer.registerWorkflow({ workflowId: runId, name: parent.name, inputs: {}, createdAt: 1, status: "paused", resumable: true });
    writer.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: seeded.checkpointId, name: seeded.name,
      argsHash: seeded.argsHash, output: seeded.output, completedAt: 1,
    });
    await writer.flush();

    const replayBackend = new DbosDurableBackend(sdk);
    await replayBackend.hydrateWorkflow(runId);
    const replayStore = createStore();
    const replay = await run(parent, {}, { runId, store: replayStore, durableBackend: replayBackend });
    await replayBackend.flush();
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.result, { value: 31 });
    assert.equal(callbackCalls, 0);
    const replayChild = replayStore.runs().find((candidate) => candidate.parentRunId === runId)!;
    const migrated = replayBackend.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    );
    assert.equal(migrated.length, 2);
    assert.equal(migrated.at(-1)?.topology?.run?.runId, replayChild.id);

    const rehydrated = new DbosDurableBackend(sdk);
    await rehydrated.hydrateWorkflow(runId);
    const hydratedLogical = rehydrated.listCheckpoints(runId).filter(
      (checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && checkpoint.argsHash === seeded.argsHash,
    );
    assert.equal(hydratedLogical.length, 2);
    assert.equal(hydratedLogical.at(-1)?.topology?.run?.runId, replayChild.id);
    const second = await run(parent, {}, { runId, store: createStore(), durableBackend: rehydrated });
    await rehydrated.flush();
    assert.equal(second.status, "completed");
    assert.equal(callbackCalls, 0);
    const entry = rehydrated.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId)!;
    const catalogRuns = completedWorkflowRunSnapshots(rehydrated, entry);
    assert.equal(catalogRuns.flatMap((candidate) => candidate.toolNodes ?? []).filter((node) => node.name === "dbos-legacy-write").length, 1);
  });
});
