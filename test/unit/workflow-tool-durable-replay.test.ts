import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash, InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";

class FailingHydrationBackend extends InMemoryDurableBackend {
  override async hydrateResumableWorkflows(): Promise<void> {
    throw new Error("durable hydration exploded");
  }
}

class TrackingHydrationBackend extends InMemoryDurableBackend {
  hydrationCalls = 0;

  override async hydrateResumableWorkflows(): Promise<void> {
    this.hydrationCalls += 1;
  }
}

afterEach(async () => {
  stageControlRegistry.clear();
  for (const runId of jobTracker.runIds()) {
    const entry = jobTracker.get(runId);
    entry?.controller.abort();
    await entry?.promise;
    jobTracker.unregister(runId);
  }
  store.clear();
  setDurableBackend(undefined);
});

describe("workflow tool durable-only checkpoint replay", () => {
  test.serial("resume keeps the original id and does not repeat a completed ctx.tool side effect", async () => {
    const workflowId = "tool-durable-replay-original-id";
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({
      workflowId,
      name: "tool-durable-replay",
      inputs: {},
      createdAt: 1,
      status: "paused",
      resumable: true,
    });
    const args = { path: "artifact.txt" };
    const argsHash = durableHash({ name: "write-once", args, ordinal: 1 });
    backend.recordCheckpoint({
      kind: "tool",
      workflowId,
      checkpointId: `tool:${argsHash}`,
      name: "write-once",
      argsHash,
      output: "cached-output",
      completedAt: 2,
    });
    assert.deepEqual(store.runs(), []);

    let sideEffectCalls = 0;
    const promptStarted = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<void>();
    const definition = workflow({
      name: "tool-durable-replay",
      description: "",
      inputs: {},
      outputs: { done: Type.Boolean() },
      run: async (ctx) => {
        const output = await ctx.tool("write-once", args, async () => {
          sideEffectCalls += 1;
          return "new-output";
        });
        assert.equal(output, "cached-output");
        await ctx.stage("continue").prompt("continue from checkpoint");
        return { done: true };
      },
    });
    const runtime = createExtensionRuntime({
      definitions: [definition],
      store,
      adapters: {
        prompt: {
          prompt: async () => {
            promptStarted.resolve();
            await releasePrompt.promise;
            return "continued";
          },
        },
      },
    });
    const execute = makeExecuteWorkflowTool(runtime, () => undefined, () => undefined);

    const result = await execute({ action: "resume", runId: workflowId }, {} as never);
    await promptStarted.promise;

    assert.equal(result.action, "resume");
    assert.equal(result.status, "running");
    assert.equal(result.runId, workflowId);
    assert.equal(sideEffectCalls, 0, "replayed ctx.tool must not execute its side-effect callback");
    assert.equal(backend.listCheckpoints(workflowId).length, 1, "replay must not duplicate the checkpoint");
    const resumedJob = jobTracker.get(workflowId);
    assert.ok(resumedJob);
    releasePrompt.resolve();
    await resumedJob.promise;
    assert.equal(store.runs().find((run) => run.id === workflowId)?.status, "completed");
  });
  test.serial("unknown resume hydrates durability while ordinary status remains local", async () => {
    const backend = new TrackingHydrationBackend();
    setDurableBackend(backend);
    const definition = workflow({ name: "lookup", description: "", inputs: {}, outputs: {}, run: () => ({}) });
    const execute = makeExecuteWorkflowTool(
      createExtensionRuntime({ definitions: [definition], store }),
      () => undefined,
      () => undefined,
    );
    const target = "durable-only-unknown-id";

    const status = await execute({ action: "status" }, {} as never);
    assert.equal(status.action, "status");
    assert.equal(backend.hydrationCalls, 0, "status must not eagerly hydrate durable history");

    const result = await execute({ action: "resume", runId: target }, {} as never);
    assert.equal(result.action, "resume");
    assert.equal(result.status, "noop");
    assert.equal(result.message, `Run not found: ${target}`);
    assert.ok(backend.hydrationCalls > 0, "not-found must follow authoritative hydration");
  });

  test.serial("resume surfaces durable hydration failures and keeps --all unsupported", async () => {
    const backend = new FailingHydrationBackend();
    setDurableBackend(backend);
    const definition = workflow({
      name: "tool-durable-failure",
      description: "",
      inputs: {},
      outputs: {},
      run: () => ({}),
    });
    const execute = makeExecuteWorkflowTool(
      createExtensionRuntime({ definitions: [definition], store }),
      () => undefined,
      () => undefined,
    );

    const failed = await execute({ action: "resume", runId: "durable-failure" }, {} as never);
    assert.equal(failed.action, "resume");
    assert.equal(failed.status, "noop");
    assert.match(failed.message, /durable hydration exploded/);
    assert.doesNotMatch(failed.message, /Run not found/);

    const all = await execute({ action: "resume", all: true }, {} as never);
    assert.deepEqual(all, {
      action: "resume",
      runId: "--all",
      status: "noop",
      message: "Resume does not support --all.",
    });
  });
});
