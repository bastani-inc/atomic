import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

describe("ctx.tool persistence and cancellation races", () => {
  test("cancellation during retry backoff leaves a cancelled node and no checkpoint", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const controller = new AbortController();
    const attempted = Promise.withResolvers<void>();
    let attempts = 0;
    const pending = run(workflow({
      name: "cancel retry backoff", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("retrying-write", {}, async () => {
          attempts += 1;
          attempted.resolve();
          throw new Error("transient write failure");
        }, { retriesAllowed: true, maxAttempts: 3, intervalMs: 10_000 });
        return {};
      },
    }), {}, { store, durableBackend: backend, signal: controller.signal });

    await attempted.promise;
    await Promise.resolve();
    controller.abort(new Error("operator cancelled during backoff"));
    const result = await pending;

    assert.equal(result.status, "killed");
    assert.equal(attempts, 1);
    assert.equal(result.toolNodes?.[0]?.status, "cancelled");
    assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool"), false);
  });

  test("writer rejection after callback success fails node and root without a completed checkpoint", async () => {
    class RejectingBackend extends InMemoryDurableBackend {
      override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
        if (checkpoint.kind === "tool") throw new Error("durable writer rejected");
        await super.recordCheckpointAsync(checkpoint);
      }
    }
    const store = createStore();
    const backend = new RejectingBackend();
    let callbackCalls = 0;
    const result = await run(workflow({
      name: "writer rejects", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("committed-side-effect", {}, async () => { callbackCalls += 1; return "external success"; });
        return {};
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(callbackCalls, 1);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /durable writer rejected/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
    assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool"), false);
  });

  test("checkpoint commit wins an in-flight cancellation but the root never claims completion", async () => {
    class GatedBackend extends InMemoryDurableBackend {
      readonly writeStarted = Promise.withResolvers<void>();
      readonly releaseWrite = Promise.withResolvers<void>();
      override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
        if (checkpoint.kind === "tool") {
          this.writeStarted.resolve();
          await this.releaseWrite.promise;
        }
        await super.recordCheckpointAsync(checkpoint);
      }
    }
    const store = createStore();
    const backend = new GatedBackend();
    const controller = new AbortController();
    const pending = run(workflow({
      name: "cancel during commit", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("commit-linearization", {}, async () => "ready-to-commit");
        return {};
      },
    }), {}, { store, durableBackend: backend, signal: controller.signal });

    await backend.writeStarted.promise;
    controller.abort(new Error("cancelled while durable write was in flight"));
    backend.releaseWrite.resolve();
    const result = await pending;

    assert.equal(result.status, "killed", "root cancellation remains authoritative");
    assert.equal(result.toolNodes?.[0]?.status, "completed", "successful durable commit is not rolled back");
    assert.equal(backend.listCheckpoints(result.runId).filter((checkpoint) => checkpoint.kind === "tool").length, 1);
  });

  test("tool-node terminal updates are idempotent", () => {
    const store = createStore();
    store.recordRunStart({ id: "terminal-idempotence", name: "terminal", inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1 });
    store.recordToolNodeStart("terminal-idempotence", {
      kind: "tool", id: "tool:terminal", name: "terminal", argsHash: "hash", ordinal: 1,
      parentIds: [], status: "pending", attachable: false,
    });
    store.recordToolNodeRunning("terminal-idempotence", "tool:terminal", 2);

    assert.equal(store.recordToolNodeEnd("terminal-idempotence", "tool:terminal", { status: "completed", endedAt: 3, resultSummary: "first" }), true);
    assert.equal(store.recordToolNodeEnd("terminal-idempotence", "tool:terminal", { status: "failed", endedAt: 4, error: "late" }), false);
    assert.deepEqual(store.runs()[0]?.toolNodes?.[0], {
      kind: "tool", id: "tool:terminal", name: "terminal", argsHash: "hash", ordinal: 1,
      parentIds: [], status: "completed", attachable: false, startedAt: 2, endedAt: 3, resultSummary: "first",
      executionOrder: 1,
    });
  });
});
