/**
 * Tests the current in-memory injection backend and durable primitives.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import { finalizeDurableTerminalStatus } from "../../packages/workflows/src/engine/run-durable-finalize.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createToolPrimitive, createCheckpointIdGenerator, sleepOrAbort } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";

const WORKFLOW_ID = "wf-test-001";

function makeToolCheckpoint(workflowId: string, name: string, argsHash: string, output: string, checkpointId = "cp-1"): DurableCheckpoint {
  return { kind: "tool", workflowId, checkpointId, name, argsHash, output, completedAt: Date.now() };
}

function makeUiCheckpoint(workflowId: string, promptHash: string, response: string, checkpointId = "cp-2"): DurableCheckpoint {
  return { kind: "ui", workflowId, checkpointId, promptKind: "input", message: "Enter name", promptHash, response, completedAt: Date.now() };
}

function makeStageCheckpoint(workflowId: string, replayKey: string, output: string, checkpointId = "cp-3"): DurableCheckpoint {
  return { kind: "stage", workflowId, checkpointId, name: "stage1", replayKey, output, completedAt: Date.now() };
}


describe("InMemoryDurableBackend", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "test-workflow",
      inputs: { topic: "testing" },
      createdAt: Date.now(),
      status: "running",
    });
  });

  test("records and retrieves tool checkpoints", () => {
    const hash = durableHash({ name: "fetch", args: { url: "https://example.com" } });
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "fetch", hash, "result-data"));
    const output = backend.getToolOutput(WORKFLOW_ID, hash);
    assert.equal(output, "result-data");
  });

  test("tool checkpoints are idempotent — no duplicate side effects", () => {
    const hash = durableHash({ name: "write-file", args: { path: "/tmp/test" } });
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "write-file", hash, "ok", "cp-1"));
    // Recording again with same checkpointId should be a no-op.
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "write-file", hash, "DIFFERENT", "cp-1"));
    assert.equal(backend.getToolOutput(WORKFLOW_ID, hash), "ok");
    assert.equal(backend.getWorkflow(WORKFLOW_ID)!.completedCheckpoints, 1);
  });

  test("records and retrieves UI response checkpoints", () => {
    const hash = durableHash({ message: "What is your name?" });
    backend.recordCheckpoint(makeUiCheckpoint(WORKFLOW_ID, hash, "Alice"));
    assert.equal(backend.getUiResponse(WORKFLOW_ID, hash), "Alice");
  });

  test("records and retrieves stage checkpoints by replay key", () => {
    backend.recordCheckpoint(makeStageCheckpoint(WORKFLOW_ID, "stage:analyze:1", "analysis result"));
    assert.equal(backend.getStageOutput(WORKFLOW_ID, "stage:analyze:1"), "analysis result");
  });

  test("listCheckpoints returns checkpoints in completion order", () => {
    const t0 = Date.now();
    backend.recordCheckpoint({ kind: "tool", workflowId: WORKFLOW_ID, checkpointId: "cp-1", name: "t1", argsHash: "h1", output: "a", completedAt: t0 + 100 });
    backend.recordCheckpoint({ kind: "tool", workflowId: WORKFLOW_ID, checkpointId: "cp-2", name: "t2", argsHash: "h2", output: "b", completedAt: t0 + 50 });
    const cps = backend.listCheckpoints(WORKFLOW_ID);
    assert.equal(cps.length, 2);
    assert.equal(cps[0]!.checkpointId, "cp-2"); // earlier timestamp first
    assert.equal(cps[1]!.checkpointId, "cp-1");
  });

  test("keeps completed workflows out of resumable listing and in completed listing", () => {
    // A `running` durable handle may belong to a crashed process (cross-session
    // crash recovery), so it is resumable at the backend level alongside
    // `paused`. Same-session double-resume is filtered by the command layer.
    assert.equal(backend.listResumableWorkflows().length, 0);
    assert.equal(backend.listCompletedWorkflows().length, 0);
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "progress", "h-progress", "done"));
    assert.equal(backend.listResumableWorkflows().length, 1);
    backend.setWorkflowStatus(WORKFLOW_ID, "completed");
    assert.equal(backend.listResumableWorkflows().length, 0);
    assert.deepEqual(backend.listCompletedWorkflows().map((entry) => entry.workflowId), [WORKFLOW_ID]);
  });

  test("listResumableWorkflows filters children and non-recoverable failures", () => {
    backend.registerWorkflow({ workflowId: "root-failed", name: "root", inputs: {}, createdAt: 1, status: "failed" });
    backend.registerWorkflow({ workflowId: "root-terminal", name: "terminal", inputs: {}, createdAt: 1, status: "failed", resumable: false });
    backend.registerWorkflow({ workflowId: "child-run", name: "child", inputs: {}, createdAt: 1, status: "running", rootWorkflowId: WORKFLOW_ID });
    const ids = backend.listResumableWorkflows().map((entry) => entry.workflowId);
    assert.ok(ids.includes("root-failed"));
    assert.ok(!ids.includes("root-terminal"));
    assert.ok(!ids.includes("child-run"));
  });

  test("non-resumable terminal finalization hides failed durable workflow", async () => {
    const runSnapshot: RunSnapshot = {
      id: WORKFLOW_ID,
      name: "test-workflow",
      inputs: {},
      status: "failed",
      stages: [],
      startedAt: 1,
      endedAt: 2,
      resumable: false,
    };

    await finalizeDurableTerminalStatus({
      runId: WORKFLOW_ID,
      runSnapshot,
      isRoot: true,
      durableBackend: backend,
    });

    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.resumable, false);
    assert.equal(backend.listResumableWorkflows().length, 0);
  });

  test("setWorkflowStatus updates status and updatedAt", () => {
    const before = backend.getWorkflow(WORKFLOW_ID)!.updatedAt;
    // Ensure updatedAt changes.
    setTimeout(() => {}, 0);
    backend.setWorkflowStatus(WORKFLOW_ID, "failed");
    const handle = backend.getWorkflow(WORKFLOW_ID)!;
    assert.equal(handle.status, "failed");
    assert.ok(handle.updatedAt >= before);
  });

  test("toMetadata shapes current DBOS workflow metadata", () => {
    const metadata = backend.toMetadata(WORKFLOW_ID);
    assert.ok(metadata);
    assert.equal(metadata.workflowId, WORKFLOW_ID);
    assert.equal(metadata.name, "test-workflow");
    assert.equal(metadata.status, "running");
  });

  test("reset clears all state", () => {
    backend.reset();
    assert.equal(backend.getWorkflow(WORKFLOW_ID), undefined);
    assert.equal(backend.listResumableWorkflows().length, 0);
  });
});



describe("ctx.tool primitive (durable caching)", () => {
  let backend: InMemoryDurableBackend;
  let cancelled: boolean;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    cancelled = false;
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "tool-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
  });

  function makeTool() {
    return createToolPrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      throwIfCancelled: () => {
        if (cancelled) throw new Error("cancelled");
      },
    });
  }

  test("executes and caches tool output", async () => {
    let callCount = 0;
    const tool = makeTool();
    const result = await tool("compute", { x: 1 }, async () => {
      callCount++;
      return "computed-value";
    });
    assert.equal(result, "computed-value");
    assert.equal(callCount, 1);
  });

  test("does not re-execute on resume — no duplicate side effects", async () => {
    let callCount = 0;
    const tool1 = makeTool();
    await tool1("write-db", { table: "users" }, async () => {
      callCount++;
      return "written";
    });

    // Simulate resume: new tool primitive, same backend.
    const tool2 = makeTool();
    const result = await tool2("write-db", { table: "users" }, async () => {
      callCount++;
      return "SHOULD-NOT-RUN";
    });
    assert.equal(result, "written");
    assert.equal(callCount, 1); // function was NOT called the second time
  });

  test("different args produce different cache keys", async () => {
    let callCount = 0;
    const tool = makeTool();
    await tool("fetch", { url: "a" }, async () => { callCount++; return "a-result"; });
    await tool("fetch", { url: "b" }, async () => { callCount++; return "b-result"; });
    assert.equal(callCount, 2);
  });

  test("same-name same-args calls are distinct within one workflow run", async () => {
    let callCount = 0;
    const tool = makeTool();
    const first = await tool("send-email", { to: "a@example.com" }, async () => { callCount++; return "sent-1"; });
    const second = await tool("send-email", { to: "a@example.com" }, async () => { callCount++; return "sent-2"; });
    assert.equal(first, "sent-1");
    assert.equal(second, "sent-2");
    assert.equal(callCount, 2);
    assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 2);
  });

  test("same-name same-args calls replay by ordinal after resume", async () => {
    let callCount = 0;
    const tool1 = makeTool();
    await tool1("send-email", { to: "a@example.com" }, async () => { callCount++; return "sent-1"; });
    await tool1("send-email", { to: "a@example.com" }, async () => { callCount++; return "sent-2"; });
    const tool2 = makeTool();
    assert.equal(await tool2("send-email", { to: "a@example.com" }, async () => "bad-1"), "sent-1");
    assert.equal(await tool2("send-email", { to: "a@example.com" }, async () => "bad-2"), "sent-2");
    assert.equal(callCount, 2);
  });

  test("retries on failure when retriesAllowed", async () => {
    let attempts = 0;
    const tool = makeTool();
    const result = await tool(
      "flaky",
      { id: 1 },
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "success";
      },
      { retriesAllowed: true, maxAttempts: 5, intervalMs: 1 },
    );
    assert.equal(result, "success");
    assert.equal(attempts, 3);
  });

  test("throws after exhausting retries", async () => {
    const tool = makeTool();
    await assert.rejects(
      () => tool("always-fails", {}, async () => { throw new Error("permanent"); }, { retriesAllowed: true, maxAttempts: 2, intervalMs: 1 }),
      /permanent/,
    );
  });

  test("throws if cancelled", async () => {
    cancelled = true;
    const tool = makeTool();
    await assert.rejects(
      () => tool("post-cancel", {}, async () => "never"),
      /cancelled/,
    );
  });

  test("cancellation during retry backoff prevents later attempts", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const tool = createToolPrimitive({
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      signal: controller.signal,
      throwIfCancelled: () => {
        if (cancelled) throw new Error("cancelled");
      },
    });
    const pending = tool("flaky", {}, async () => {
      attempts++;
      if (attempts === 1) {
        cancelled = true;
        controller.abort(new Error("cancelled"));
      }
      throw new Error("transient");
    }, { retriesAllowed: true, maxAttempts: 3, intervalMs: 50 });
    await assert.rejects(() => pending, /cancelled/);
    assert.equal(attempts, 1);
  });

  test("sleepOrAbort removes abort listener after normal completion", async () => {
    class CountingSignal extends EventTarget implements AbortSignal {
      aborted = false;
      reason: Error | undefined;
      onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
      listenerCount = 0;
      throwIfAborted(): void {
        if (this.aborted) throw this.reason ?? new Error("aborted");
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
        if (type === "abort") this.listenerCount++;
        super.addEventListener(type, listener, options);
      }
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
        if (type === "abort") this.listenerCount--;
        super.removeEventListener(type, listener, options);
      }
    }
    const signal = new CountingSignal();
    await sleepOrAbort(1, signal);
    assert.equal(signal.listenerCount, 0);
  });

  test("awaits async checkpoint persistence before returning side-effect result", async () => {
    class AsyncBackend extends InMemoryDurableBackend {
      persisted = false;
      async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
        await Promise.resolve();
        super.recordCheckpoint(checkpoint);
        this.persisted = true;
      }
    }
    const asyncBackend = new AsyncBackend();
    asyncBackend.registerWorkflow({ workflowId: WORKFLOW_ID, name: "async", inputs: {}, createdAt: Date.now(), status: "running" });
    const tool = createToolPrimitive({
      workflowId: WORKFLOW_ID,
      backend: asyncBackend,
      nextCheckpointId: createCheckpointIdGenerator(),
      throwIfCancelled: () => {},
    });

    const result = await tool("side-effect", {}, async () => "done");
    assert.equal(result, "done");
    assert.equal(asyncBackend.persisted, true);
  });
});
