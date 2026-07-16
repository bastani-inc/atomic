/**
 * Tests for the durable-backend performance fixes:
 *  - stat-gated parse cache with writer invalidation (file-backend-cache.ts)
 *  - async checkpoint persistence with per-file write serialization
 *  - targeted (per-id) durable resume preparation for session_start
 *  - transcript-scan cache correctness after session file changes
 *
 * cross-ref: startup/resume performance investigation — the full
 * `~/.atomic/workflow-durable` scan at session_start and per-call re-parsing
 * scaled with total workflow history instead of the current session.
 */
import { describe, test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowFileDurableBackend,
  durableStateFileFor,
} from "../../packages/workflows/src/durable/file-backend.js";
import {
  invalidateDurableFileStateCache,
  readDurableFileStateCached,
} from "../../packages/workflows/src/durable/file-backend-cache.js";
import { enqueueDurableFileWrite } from "../../packages/workflows/src/durable/file-lock.js";
import { prepareTargetedDurableResumable } from "../../packages/workflows/src/durable/resume-runtime.js";
import { collectSessionWorkflowIds } from "../../packages/workflows/src/shared/resumable-workflow-notices.js";
import { scanResumableWorkflows } from "../../packages/workflows/src/durable/resume-catalog.js";
import { DURABLE_FORMAT_VERSION } from "../../packages/workflows/src/durable/format-version.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";

function toolCheckpoint(workflowId: string, ordinal: number): DurableCheckpoint {
  return {
    kind: "tool",
    workflowId,
    checkpointId: `cp-${ordinal}`,
    name: `tool-${ordinal}`,
    argsHash: `hash-${ordinal}`,
    output: `output-${ordinal}`,
    completedAt: Date.now() + ordinal,
  };
}

describe("durable performance fixes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-durable-perf-"));
    invalidateDurableFileStateCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    invalidateDurableFileStateCache();
  });

  function registerPausedResumable(backend: WorkflowFileDurableBackend, workflowId: string): void {
    backend.registerWorkflow({
      workflowId,
      name: `wf-${workflowId}`,
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
    backend.recordCheckpoint(toolCheckpoint(workflowId, 1));
    backend.setWorkflowStatus(workflowId, "paused");
  }

  test("stat-gated cache returns identical parse for unchanged files and refreshes on change", () => {
    const backend = new WorkflowFileDurableBackend(dir);
    registerPausedResumable(backend, "wf-cache");
    const filePath = durableStateFileFor(dir, "wf-cache");

    const first = readDurableFileStateCached(filePath);
    const second = readDurableFileStateCached(filePath);
    assert.equal(first.kind, "current");
    // Unchanged stat → the exact same parsed object (no re-read, no re-parse).
    assert.equal(second, first);

    // External replacement (different size) is observed on the next read.
    writeFileSync(filePath, JSON.stringify({
      version: DURABLE_FORMAT_VERSION,
      workflows: [],
      deletedWorkflowIds: ["wf-cache"],
    }));
    const third = readDurableFileStateCached(filePath);
    assert.notEqual(third, first);
    assert.equal(third.kind, "current");
    if (third.kind === "current") {
      assert.deepEqual(third.state.deletedWorkflowIds, ["wf-cache"]);
    }
  });

  test("backend writers invalidate the cache so readers observe their own writes", () => {
    const backend = new WorkflowFileDurableBackend(dir);
    registerPausedResumable(backend, "wf-writer");
    const filePath = durableStateFileFor(dir, "wf-writer");

    const before = readDurableFileStateCached(filePath);
    assert.equal(before.kind, "current");
    backend.setWorkflowStatus(workflowIdOf(before) ?? "wf-writer", "running");
    const after = readDurableFileStateCached(filePath);
    assert.equal(after.kind, "current");
    if (after.kind === "current") {
      assert.equal(after.state.workflows[0]?.handle.status, "running");
    }
  });

  test("cached reads keep cross-process listing behavior intact", () => {
    const writer = new WorkflowFileDurableBackend(dir);
    registerPausedResumable(writer, "wf-listing");

    const reader = new WorkflowFileDurableBackend(dir);
    const listed = reader.listResumableWorkflows();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.workflowId, "wf-listing");
    // A second listing of the unchanged directory stays correct (cache hits).
    assert.equal(reader.listResumableWorkflows().length, 1);

    writer.setWorkflowStatus("wf-listing", "completed");
    assert.equal(reader.listResumableWorkflows().length, 0);
  });

  test("recordCheckpointAsync persists durably and preserves per-file write order", async () => {
    const backend = new WorkflowFileDurableBackend(dir);
    backend.registerWorkflow({
      workflowId: "wf-async",
      name: "async-checkpoints",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });

    // Fire several async checkpoint writes concurrently; the per-file queue
    // must serialize them without losing any update.
    await Promise.all([2, 3, 4, 5, 6].map((ordinal) =>
      backend.recordCheckpointAsync(toolCheckpoint("wf-async", ordinal))));

    assert.equal(backend.listCheckpoints("wf-async").length, 5);
    for (const ordinal of [2, 3, 4, 5, 6]) {
      assert.equal(backend.getToolOutput("wf-async", `hash-${ordinal}`), `output-${ordinal}`);
    }

    // A fresh backend (new process view) replays the same checkpoints.
    const replay = new WorkflowFileDurableBackend(dir);
    assert.equal(replay.listCheckpoints("wf-async").length, 5);
    assert.equal(replay.getToolOutput("wf-async", "hash-6"), "output-6");
  });

  test("enqueueDurableFileWrite serializes tasks per path in submission order", async () => {
    const order: number[] = [];
    const gate = Promise.withResolvers<void>();
    const first = enqueueDurableFileWrite("/tmp/queue-a", async () => {
      await gate.promise;
      order.push(1);
    });
    const second = enqueueDurableFileWrite("/tmp/queue-a", async () => {
      order.push(2);
    });
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2]);
  });

  test("targeted preparation resolves only the requested ids", async () => {
    const backend = new WorkflowFileDurableBackend(dir);
    registerPausedResumable(backend, "wf-target-1");
    registerPausedResumable(backend, "wf-target-2");
    registerPausedResumable(backend, "wf-untouched");

    const entries = await prepareTargetedDurableResumable(backend, [
      "wf-target-1",
      "wf-target-2",
      "wf-target-1", // duplicates are collapsed
      "wf-missing",
    ]);
    assert.deepEqual(entries.map((entry) => entry.workflowId).sort(), ["wf-target-1", "wf-target-2"]);
    assert.equal(entries.every((entry) => entry.status === "paused"), true);
  });

  test("collectSessionWorkflowIds extracts ids from wrapped and direct entries", () => {
    const ids = collectSessionWorkflowIds([
      { type: "custom", customType: "workflow.durable.checkpoint", data: { workflowId: "wf-wrapped" } },
      { type: "workflow.durable.checkpoint", workflowId: "wf-direct" },
      { type: "message", role: "user" },
      "not-an-entry",
    ]);
    assert.deepEqual([...ids].sort(), ["wf-direct", "wf-wrapped"]);
  });

  test("transcript scan cache serves unchanged files and refreshes changed ones", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "atomic-session-scan-"));
    try {
      const sessionFile = join(sessionDir, "session-1.jsonl");
      const row = (status: string, ts: number): string => JSON.stringify({
        type: "workflow.durable.checkpoint",
        formatVersion: DURABLE_FORMAT_VERSION,
        workflowId: "wf-scan",
        name: "scan-workflow",
        inputs: {},
        status,
        completedCheckpoints: 1,
        pendingPrompts: 0,
        ts,
      });
      writeFileSync(sessionFile, `${JSON.stringify({ type: "message", role: "user" })}\n${row("paused", 1000)}\n`);

      const first = scanResumableWorkflows(sessionDir);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.status, "paused");

      // Unchanged file → same result from the stat-gated cache.
      const second = scanResumableWorkflows(sessionDir);
      assert.equal(second.length, 1);

      // Appending a newer row changes size → the cache re-reads the file.
      writeFileSync(sessionFile, `${row("paused", 1000)}\n${row("running", 2000)}\n`);
      const third = scanResumableWorkflows(sessionDir);
      assert.equal(third.length, 1);
      assert.equal(third[0]?.status, "running");
      assert.equal(third[0]?.updatedAt, 2000);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

function workflowIdOf(result: ReturnType<typeof readDurableFileStateCached>): string | undefined {
  return result.kind === "current" ? result.state.workflows[0]?.handle.workflowId : undefined;
}
