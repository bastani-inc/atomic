import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createToolPrimitive } from "../../packages/workflows/src/durable/tool-primitive.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

describe("ctx.tool admitted execution barrier", () => {
  test("tracking returns the exact execution promise and callback value", async () => {
    const backend = new InMemoryDurableBackend();
    let admitted: Promise<unknown> | undefined;
    let trackedBeforeCallback = false;
    let boundNodeId: string | undefined;
    const exactValue = { names: ["same", "same"], raw: " value " } as const;
    const tool = createToolPrimitive({
      workflowId: "promise-identity",
      backend,
      nextCheckpointId: () => "unused",
      throwIfCancelled: () => undefined,
      trackExecution<T>(execution: Promise<T>) {
        admitted = execution;
        trackedBeforeCallback = true;
        return { bindNode(nodeId: string): void { boundNodeId = nodeId; } };
      },
    });

    const returned = tool("identity", {}, async () => {
      assert.equal(trackedBeforeCallback, true, "rejection observation is installed before the callback starts");
      assert.match(boundNodeId ?? "", /^tool:/, "node identity is bound before the callback starts");
      return exactValue;
    });
    assert.equal(returned, admitted);
    assert.equal(await returned, exactValue);
  });

  test("unawaited admitted success delays root completion until checkpointed", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rootSettled = false;

    const pending = run(workflow({
      name: "unawaited-tool-success",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        void ctx.tool("delayed-write", {}, async () => {
          entered.resolve();
          await release.promise;
          return "written";
        });
        return {};
      },
    }), {}, { store, durableBackend: backend });
    void pending.then(() => { rootSettled = true; });

    await entered.promise;
    await Bun.sleep(0);
    assert.equal(rootSettled, false, "admitted tools are part of root completion");
    assert.equal(store.runs()[0]?.status, "running");
    assert.equal(store.runs()[0]?.toolNodes?.[0]?.status, "running");

    release.resolve();
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.equal(result.toolNodes?.[0]?.status, "completed");
    assert.equal(backend.listCheckpoints(result.runId).filter((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "delayed-write").length, 1);
  });

  test("caught tool rejection preserves identity and still fails the root", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const original = new Error("caught original tool failure");
    let caught: unknown;

    const result = await run(workflow({
      name: "caught-tool-failure",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("caught-failure", {}, async () => { throw original; });
        } catch (error) {
          caught = error;
        }
        return {};
      },
    }), {}, { store, durableBackend: backend });

    assert.equal(caught, original, "workflow code receives the original rejection object");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /caught original tool failure/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
    assert.equal(store.runs()[0]?.failedStageId, undefined);
    assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "caught-failure"), false);
  });

  test("unawaited rejection is observed and fails root without an unhandled rejection", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = run(workflow({
        name: "unawaited-tool-failure", description: "", inputs: {}, outputs: {},
        run: async (ctx) => {
          void ctx.tool("unawaited-failure", {}, async () => {
            entered.resolve();
            await release.promise;
            throw new Error("unawaited original failure");
          });
          return {};
        },
      }), {}, { store, durableBackend: backend });

      await entered.promise;
      release.resolve();
      const result = await pending;
      await Bun.sleep(0);
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /unawaited original failure/);
      assert.equal(result.toolNodes?.[0]?.status, "failed");
      assert.deepEqual(unhandled, []);
      assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "unawaited-failure"), false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("drains tools admitted by an earlier tool settlement continuation", async () => {
    const store = createStore();
    const firstRelease = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    let rootSettled = false;
    const pending = run(workflow({
      name: "fixed-point-tools", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        const first = ctx.tool("first", {}, async () => { await firstRelease.promise; return "first"; });
        void first.then(() => ctx.tool("second", {}, async () => {
          secondEntered.resolve();
          await secondRelease.promise;
          return "second";
        }));
        return {};
      },
    }), {}, { store });
    void pending.then(() => { rootSettled = true; });

    firstRelease.resolve();
    await secondEntered.promise;
    await Bun.sleep(0);
    assert.equal(rootSettled, false);
    assert.deepEqual(store.runs()[0]?.toolNodes?.map((node) => [node.name, node.status]), [
      ["first", "completed"],
      ["second", "running"],
    ]);
    secondRelease.resolve();
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.toolNodes?.map((node) => [node.name, node.status, node.executionOrder]), [
      ["first", "completed", 1],
      ["second", "completed", 2],
    ]);
    assert.deepEqual(result.toolNodes?.[1]?.parentIds, [result.toolNodes?.[0]?.id]);
  });

  test("uncaught workflow error wins after admitted tools become terminal", async () => {
    const store = createStore();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = run(workflow({
      name: "outer-error-precedence", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("also-fails", {}, async () => {
          entered.resolve();
          await release.promise;
          throw new Error("tool failure loses precedence");
        });
        throw new Error("outer domain failure");
      },
    }), {}, { store });

    await entered.promise;
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /outer domain failure/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
  });

  test("selected ctx.exit remains authoritative after admitted tool cancellation", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = run(workflow({
      name: "exit-precedence", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("cancelled-by-exit", {}, async () => {
          entered.resolve();
          await release.promise;
          return "too-late";
        });
        ctx.exit({ status: "completed" });
      },
    }), {}, { store, durableBackend: backend });

    await entered.promise;
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.equal(result.exited, true);
    assert.equal(result.toolNodes?.[0]?.status, "cancelled");
    assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "cancelled-by-exit"), false);
  });

  test("multiple failures select the first admitted original error", async () => {
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const firstError = new Error("first admitted failure");
    const secondError = new Error("second admitted failure");
    const pending = run(workflow({
      name: "multiple-tool-failures", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("first-failure", {}, async () => { await firstRelease.promise; throw firstError; });
        void ctx.tool("second-failure", {}, async () => { await secondRelease.promise; throw secondError; });
        return {};
      },
    }), {});

    secondRelease.resolve();
    await Bun.sleep(0);
    firstRelease.resolve();
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /first admitted failure/);
    assert.deepEqual(result.toolNodes?.map((node) => [node.name, node.status]), [
      ["first-failure", "failed"],
      ["second-failure", "failed"],
    ]);
  });

  test("unawaited retry exhaustion fails with the final original retry error", async () => {
    const errors = [new Error("retry one"), new Error("retry final")];
    let attempts = 0;
    const result = await run(workflow({
      name: "unawaited-retry-exhaustion", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("retrying", {}, async () => { throw errors[attempts++]!; }, {
          retriesAllowed: true,
          maxAttempts: 2,
          intervalMs: 0,
        });
        return {};
      },
    }), {});

    assert.equal(attempts, 2);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /retry final/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
  });

  test("external cancellation wins after an unawaited admitted tool settles", async () => {
    const store = createStore();
    const backend = new InMemoryDurableBackend();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = run(workflow({
      name: "unawaited-cancel", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("cancelled-write", {}, async () => {
          entered.resolve();
          await release.promise;
          return "late";
        });
        return {};
      },
    }), {}, { store, durableBackend: backend, signal: controller.signal });

    await entered.promise;
    controller.abort(new Error("operator cancelled"));
    release.resolve();
    const result = await pending;
    assert.equal(result.status, "killed");
    assert.equal(result.toolNodes?.[0]?.status, "cancelled");
    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(backend.listCheckpoints(result.runId).some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "cancelled-write"), false);
  });
});
