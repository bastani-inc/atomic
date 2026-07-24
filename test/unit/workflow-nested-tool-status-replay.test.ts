import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { completedWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { buildWorkflowStatusListing } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { topLevelExpandedSnapshots } from "../../packages/workflows/src/extension/workflow-targets.js";
import { store } from "../../packages/workflows/src/shared/store.js";

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe("nested ctx.tool status replay", () => {
  test("live no-target status exposes a running tool-only child", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const child = workflow({
      name: "live-status-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("live-child-tool", {}, async () => { entered.resolve(); await release.promise; return "done"; });
        return {};
      },
    });
    const parent = workflow({
      name: "live-status-root", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "live-child" }); return {}; },
    });
    const pending = run(parent, {}, { runId: "live-nested-status-root", store, durableBackend: new InMemoryDurableBackend() });

    await entered.promise;
    const listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), "all");
    assert.equal(listing.snapshots.length, 1);
    assert.deepEqual(listing.snapshots[0]?.stages, []);
    assert.deepEqual(listing.runs[0]?.tools?.map((tool) => ({
      name: tool.name, status: tool.status, runName: tool.runName, depth: tool.depth,
    })), [{ name: "live-child-tool", status: "running", runName: "live-status-child", depth: 1 }]);
    release.resolve();
    assert.equal((await pending).status, "completed");
  });

  test("replay and completed restoration expose one cached child tool without rerunning its callback", async () => {
    const runId = "nested-status-replay-root";
    const backend = new InMemoryDurableBackend();
    let callbackCalls = 0;
    const child = workflow({
      name: "nested-status-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("nested-publish", {}, async () => { callbackCalls += 1; return "published"; });
        return {};
      },
    });
    const parent = workflow({
      name: "nested-status-root", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "nested-child" }); return {}; },
    });

    const first = await run(parent, {}, { runId, store, durableBackend: backend });
    assert.equal(first.status, "completed");
    assert.equal(callbackCalls, 1);
    let listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), "all");
    assert.deepEqual(listing.runs[0]?.tools?.map((tool) => [tool.name, tool.status, tool.depth]), [
      ["nested-publish", "completed", 1],
    ]);

    store.clear();
    const replay = await run(parent, {}, { runId, store, durableBackend: backend });
    assert.equal(replay.status, "completed");
    assert.equal(callbackCalls, 1, "durable replay must not repeat the child callback");
    listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), "all");
    const replayTools = listing.runs[0]?.tools ?? [];
    assert.equal(replayTools.length, 1);
    assert.equal(replayTools[0]?.name, "nested-publish");
    assert.equal(replayTools[0]?.status, "cached");
    assert.equal(replayTools[0]?.depth, 1);
    assert.equal(replayTools[0]?.runId, store.runs().find((entry) => entry.parentRunId === runId)?.id);
    assert.equal(listing.snapshots[0]?.toolNodes?.length, 1);

    const entry = backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === runId);
    assert.ok(entry !== undefined);
    const restored = completedWorkflowRunSnapshots(backend, entry);
    store.clear();
    for (const snapshot of restored) store.recordRunStart(snapshot);
    listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), "all");
    assert.deepEqual(listing.runs[0]?.tools?.map((tool) => ({
      name: tool.name,
      status: tool.status,
      runId: tool.runId,
      runName: tool.runName,
      depth: tool.depth,
      attachable: tool.attachable,
    })), [{
      name: "nested-publish",
      status: "cached",
      runId: restored.find((candidate) => candidate.parentRunId === runId)?.id,
      runName: "nested-status-child",
      depth: 1,
      attachable: false,
    }]);
    assert.equal(callbackCalls, 1);
  });
});
