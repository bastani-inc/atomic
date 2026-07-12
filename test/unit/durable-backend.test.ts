/**
 * Tests for the durable workflow backend — in-memory and file-backed.
 *
 * cross-ref: issue #1498 — DBOS-backed cross-session resumability.
 * Verifies: checkpoint idempotency, no-duplicate side effects, resume listing.
 */
import { describe, test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend, WorkflowFileDurableBackend, durableStateFileFor } from "../../packages/workflows/src/durable/file-backend.js";
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

function assertModeIfSupported(path: string, mode: number): void {
  if (process.platform === "win32") return;
  assert.equal(statSync(path).mode & 0o777, mode);
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

  test("toCacheEntry exports session-cache entry", () => {
    const entry = backend.toCacheEntry(WORKFLOW_ID);
    assert.ok(entry);
    assert.equal(entry!.type, "workflow.durable.checkpoint");
    assert.equal(entry!.workflowId, WORKFLOW_ID);
    assert.equal(entry!.name, "test-workflow");
    assert.equal(entry!.status, "running");
  });

  test("reset clears all state", () => {
    backend.reset();
    assert.equal(backend.getWorkflow(WORKFLOW_ID), undefined);
    assert.equal(backend.listResumableWorkflows().length, 0);
  });
});

describe("FileDurableBackend", () => {
  let tmpDir: string;
  let backend: FileDurableBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "durable-test-"));
    backend = new FileDurableBackend(join(tmpDir, "state.json"));
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "file-workflow",
      inputs: { key: "value" },
      createdAt: Date.now(),
      status: "running",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists checkpoints across backend instances (cross-session resume)", () => {
    const hash = durableHash({ name: "side-effect", args: { id: 42 } });
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "side-effect", hash, "done"));
    assert.equal(backend.getToolOutput(WORKFLOW_ID, hash), "done");

    // Simulate a new session/process by creating a new backend instance.
    const backend2 = new FileDurableBackend(join(tmpDir, "state.json"));
    assert.equal(backend2.getToolOutput(WORKFLOW_ID, hash), "done");
    assert.equal(backend2.getWorkflow(WORKFLOW_ID)!.name, "file-workflow");
  });

  test("lists resumable workflows from a new backend instance", () => {
    backend.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "progress", "h-progress", "done"));
    backend.setWorkflowStatus(WORKFLOW_ID, "paused");
    const backend2 = new FileDurableBackend(join(tmpDir, "state.json"));
    const resumable = backend2.listResumableWorkflows();
    assert.equal(resumable.length, 1);
    assert.equal(resumable[0]!.workflowId, WORKFLOW_ID);
    assert.equal(resumable[0]!.status, "paused");
  });

  test("merges concurrent backend updates instead of losing stale writes", () => {
    const file = join(tmpDir, "state.json");
    const backendA = new FileDurableBackend(file);
    const backendB = new FileDurableBackend(file);
    const hashA = durableHash({ name: "a", args: {} });
    const hashB = durableHash({ name: "b", args: {} });
    backendA.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "a", hashA, "A", "cp-a"));
    backendB.recordCheckpoint(makeToolCheckpoint(WORKFLOW_ID, "b", hashB, "B", "cp-b"));
    const reloaded = new FileDurableBackend(file);
    assert.equal(reloaded.getToolOutput(WORKFLOW_ID, hashA), "A");
    assert.equal(reloaded.getToolOutput(WORKFLOW_ID, hashB), "B");
  });
});

describe("WorkflowFileDurableBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "durable-workflow-files-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stores workflows in separate files and aggregates resume listing", () => {
    const backend = new WorkflowFileDurableBackend(tmpDir);
    backend.registerWorkflow({ workflowId: "wf-a", name: "a", inputs: {}, createdAt: 1, status: "running" });
    backend.recordCheckpoint(makeToolCheckpoint("wf-a", "a", "hash-a", "A", "cp-a"));
    backend.setWorkflowStatus("wf-a", "paused");
    backend.registerWorkflow({ workflowId: "wf-b", name: "b", inputs: {}, createdAt: 2, status: "running" });
    backend.recordCheckpoint(makeToolCheckpoint("wf-b", "b", "hash-b", "B", "cp-b"));
    backend.setWorkflowStatus("wf-b", "failed");

    assert.equal(existsSync(durableStateFileFor(tmpDir, "wf-a")), true);
    assert.equal(existsSync(durableStateFileFor(tmpDir, "wf-b")), true);
    assert.equal(existsSync(join(tmpDir, "state.json")), false);

    const reloaded = new WorkflowFileDurableBackend(tmpDir);
    const ids = reloaded.listResumableWorkflows().map((entry) => entry.workflowId).sort();
    assert.deepEqual(ids, ["wf-a", "wf-b"]);
  });

  test("retains completed workflow files for authoritative inspection", () => {
    const backend = new WorkflowFileDurableBackend(tmpDir);
    backend.registerWorkflow({ workflowId: "wf-done", name: "done", inputs: {}, createdAt: 1, status: "running" });
    backend.recordCheckpoint(makeToolCheckpoint("wf-done", "done", "hash-done", "ok", "cp-done"));
    backend.setWorkflowStatus("wf-done", "completed");

    assert.equal(existsSync(durableStateFileFor(tmpDir, "wf-done")), true);
    assert.equal(backend.listResumableWorkflows().length, 0);
    assert.deepEqual(backend.listCompletedWorkflows().map((entry) => entry.workflowId), ["wf-done"]);
  });

  test("reset clears workflow files without wiping unrelated durable-root files", () => {
    const backend = new WorkflowFileDurableBackend(tmpDir);
    const keepPath = join(tmpDir, "notes.txt");
    writeFileSync(keepPath, "keep", "utf-8");
    backend.registerWorkflow({ workflowId: "wf-reset", name: "reset", inputs: {}, createdAt: 1, status: "running" });
    backend.recordCheckpoint(makeToolCheckpoint("wf-reset", "reset", "hash-reset", "ok", "cp-reset"));

    backend.reset();

    assert.equal(existsSync(durableStateFileFor(tmpDir, "wf-reset")), false);
    assert.equal(existsSync(keepPath), true);
  });

  test("uses restrictive permissions for durable directory and state files", () => {
    const backend = new WorkflowFileDurableBackend(tmpDir);
    backend.registerWorkflow({ workflowId: "wf-secure", name: "secure", inputs: {}, createdAt: 1, status: "running" });
    const filePath = durableStateFileFor(tmpDir, "wf-secure");
    assert.equal(existsSync(filePath), true);

    assertModeIfSupported(tmpDir, 0o700);
    assertModeIfSupported(filePath, 0o600);
  });

  test("merges same-workflow updates through per-workflow locks", () => {
    const backendA = new WorkflowFileDurableBackend(tmpDir);
    const backendB = new WorkflowFileDurableBackend(tmpDir);
    backendA.registerWorkflow({ workflowId: "wf-merge", name: "merge", inputs: {}, createdAt: 1, status: "running" });
    backendA.recordCheckpoint(makeToolCheckpoint("wf-merge", "a", "hash-a", "A", "cp-a"));
    backendB.recordCheckpoint(makeToolCheckpoint("wf-merge", "b", "hash-b", "B", "cp-b"));

    const reloaded = new WorkflowFileDurableBackend(tmpDir);
    assert.equal(reloaded.getToolOutput("wf-merge", "hash-a"), "A");
    assert.equal(reloaded.getToolOutput("wf-merge", "hash-b"), "B");
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
