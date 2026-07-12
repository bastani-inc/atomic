import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
  completedWorkflowSnapshot,
  listCompletedFromBackend,
  listOpenableCompletedWorkflows,
  resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { listResumableFromBackend } from "../../packages/workflows/src/durable/resume-catalog.js";

let tempDir = "";

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-catalog-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function writeSessionTranscript(path: string, id: string): void {
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${id}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "prior context", timestamp: Date.now() } }),
  ].join("\n") + "\n");
}

function registerCompleted(backend: InMemoryDurableBackend, id: string): void {
  backend.registerWorkflow({
    workflowId: id,
    name: "completed-flow",
    inputs: { topic: "done" },
    createdAt: 10,
    updatedAt: 30,
    status: "completed",
  });
}

describe("completed durable catalog", () => {
  test("keeps completed listing distinct from resumability predicates", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "paused", name: "paused-flow", inputs: {}, createdAt: 1, status: "paused", completedCheckpoints: 1 });
    registerCompleted(backend, "completed");
    backend.recordCheckpoint({ kind: "tool", workflowId: "completed", checkpointId: "tool:1", name: "read", argsHash: "hash", output: "ok", completedAt: 20 });

    assert.deepEqual(listResumableFromBackend(backend).map((entry) => entry.workflowId), ["paused"]);
    assert.deepEqual(listCompletedFromBackend(backend).map((entry) => entry.workflowId), ["completed"]);
  });

  test("filters stale completed rows and reconstructs authoritative stage detail", () => {
    const backend = new InMemoryDurableBackend();
    const transcript = join(tempDir, "stage.jsonl");
    writeSessionTranscript(transcript, "valid-session");
    registerCompleted(backend, "valid-completed");
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "valid-completed",
      checkpointId: "stage:1",
      name: "summarize",
      replayKey: "stage:summarize:1",
      output: "finished",
      sessionFile: transcript,
      model: "provider/model",
      completedAt: 20,
    });
    registerCompleted(backend, "stale-completed");
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "stale-completed",
      checkpointId: "stage:1",
      name: "missing",
      replayKey: "stage:missing:1",
      sessionFile: join(tempDir, "missing.jsonl"),
      completedAt: 20,
    });

    assert.deepEqual(listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId), ["valid-completed"]);
    const snapshot = completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!);
    assert.equal(snapshot?.status, "completed");
    assert.equal(snapshot?.stages[0]?.result, "finished");
    assert.equal(snapshot?.stages[0]?.model, "provider/model");
    assert.equal(resolveCompletedWorkflow("stale", backend).kind, "stale");
  });

  test("hides completed rows without a reopenable retained conversation", () => {
    const backend = new InMemoryDurableBackend();
    const cases = [
      { id: "no-session", sessionFile: undefined },
      { id: "empty-session", sessionFile: join(tempDir, "empty.jsonl") },
      { id: "malformed-session", sessionFile: join(tempDir, "malformed.jsonl") },
      { id: "directory-session", sessionFile: join(tempDir, "directory.jsonl") },
      { id: "header-only", sessionFile: join(tempDir, "header-only.jsonl") },
      { id: "invalid-message", sessionFile: join(tempDir, "invalid-message.jsonl") },
    ] as const;
    writeFileSync(cases[1].sessionFile, "");
    writeFileSync(cases[2].sessionFile, "not-json\n");
    mkdirSync(cases[3].sessionFile);
    writeFileSync(cases[4].sessionFile, `${JSON.stringify({ type: "session", id: "header-only" })}\n`);
    writeFileSync(cases[5].sessionFile, [
      JSON.stringify({ type: "session", id: "invalid-message" }),
      JSON.stringify({ type: "message" }),
    ].join("\n"));
    for (const item of cases) {
      registerCompleted(backend, item.id);
      backend.recordCheckpoint({
        kind: "stage",
        workflowId: item.id,
        checkpointId: "stage:1",
        name: "final",
        replayKey: "stage:final:1",
        ...(item.sessionFile === undefined ? {} : { sessionFile: item.sessionFile }),
        completedAt: 20,
      });
    }
    registerCompleted(backend, "tool-only");
    backend.recordCheckpoint({ kind: "tool", workflowId: "tool-only", checkpointId: "tool:1", name: "read", argsHash: "hash", output: "ok", completedAt: 20 });

    assert.deepEqual(listOpenableCompletedWorkflows(backend), []);
    for (const item of [...cases, { id: "tool-only" }]) {
      assert.equal(resolveCompletedWorkflow(item.id, backend).kind, "stale");
    }
  });

  test("validates the retained transcript after merging repeated stage checkpoints", () => {
    const backend = new InMemoryDurableBackend();
    const validTranscript = join(tempDir, "retained.jsonl");
    writeSessionTranscript(validTranscript, "retained-session");
    registerCompleted(backend, "merged-stage");
    backend.recordCheckpoint({
      kind: "stage", workflowId: "merged-stage", checkpointId: "stage:1", name: "final",
      replayKey: "stage:final:1", sessionFile: join(tempDir, "obsolete-missing.jsonl"), completedAt: 20,
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "merged-stage", checkpointId: "stage:2", name: "final",
      replayKey: "stage:final:1", sessionFile: validTranscript, output: "done", completedAt: 30,
    });

    assert.deepEqual(listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId), ["merged-stage"]);
    assert.equal(completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!)?.stages[0]?.sessionFile, validTranscript);
  });
});
