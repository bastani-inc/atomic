import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
  completedWorkflowRunSnapshots,
  completedWorkflowSnapshot,
  listCompletedFromBackend,
  listOpenableCompletedWorkflows,
  resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { listResumableFromBackend } from "../../packages/workflows/src/durable/resume-catalog.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";

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

  test("keeps a completed workflow when at least one stage has a usable transcript", () => {
    const backend = new InMemoryDurableBackend();
    const validTranscript = join(tempDir, "usable.jsonl");
    writeSessionTranscript(validTranscript, "usable-session");
    registerCompleted(backend, "partially-retained");
    backend.recordCheckpoint({
      kind: "stage", workflowId: "partially-retained", checkpointId: "stage:1", name: "retained",
      replayKey: "stage:retained:1", sessionFile: validTranscript, completedAt: 20,
    });
    backend.recordCheckpoint({
      kind: "stage", workflowId: "partially-retained", checkpointId: "stage:2", name: "stale",
      replayKey: "stage:stale:1", sessionFile: join(tempDir, "missing.jsonl"), completedAt: 21,
    });

    const snapshot = completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!);
    assert.deepEqual(listOpenableCompletedWorkflows(backend).map((item) => item.workflowId), ["partially-retained"]);
    assert.equal(snapshot?.stages[0]?.sessionFile, validTranscript);
    assert.equal(snapshot?.stages[1]?.sessionFile, undefined);
  });

  test("rejects partially malformed and context-empty transcripts", () => {
    const backend = new InMemoryDurableBackend();
    const malformed = join(tempDir, "partially-malformed.jsonl");
    writeFileSync(malformed, [
      JSON.stringify({ type: "session", id: "partially-malformed" }),
      JSON.stringify({ type: "message", id: "valid", timestamp: new Date().toISOString(), message: { role: "user", content: "context" } }),
      "not-json",
    ].join("\n"));
    const emptyContent = [
      { id: "blank-string", content: "   " },
      { id: "empty-array", content: [] },
      { id: "empty-object", content: {} },
      { id: "empty-block", content: [{}] },
      { id: "blank-text-block", content: [{ type: "text", text: "" }] },
    ] as const;
    registerCompleted(backend, "partially-malformed");
    backend.recordCheckpoint({
      kind: "stage", workflowId: "partially-malformed", checkpointId: "stage:1", name: "final",
      replayKey: "stage:final:1", sessionFile: malformed, completedAt: 20,
    });
    for (const item of emptyContent) {
      const path = join(tempDir, `${item.id}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ type: "session", id: item.id }),
        JSON.stringify({ type: "message", id: `${item.id}-message`, timestamp: new Date().toISOString(), message: { role: "user", content: item.content } }),
      ].join("\n"));
      registerCompleted(backend, item.id);
      backend.recordCheckpoint({
        kind: "stage", workflowId: item.id, checkpointId: "stage:1", name: "final",
        replayKey: "stage:final:1", sessionFile: path, completedAt: 20,
      });
    }

    assert.deepEqual(listOpenableCompletedWorkflows(backend), []);
  });

  test("accepts a retained transcript with a meaningful structured content block", () => {
    const backend = new InMemoryDurableBackend();
    const path = join(tempDir, "structured-context.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "session", id: "structured-context" }),
      JSON.stringify({
        type: "message",
        id: "structured-context-message",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "retained context" }] },
      }),
    ].join("\n"));
    registerCompleted(backend, "structured-context");
    backend.recordCheckpoint({
      kind: "stage", workflowId: "structured-context", checkpointId: "stage:1", name: "final",
      replayKey: "stage:final:1", sessionFile: path, completedAt: 20,
    });

    assert.deepEqual(listOpenableCompletedWorkflows(backend).map((item) => item.workflowId), ["structured-context"]);
  });

  test("reconstructs nested parallel runs and accumulated completed duration", () => {
    const backend = new InMemoryDurableBackend();
    const transcript = join(tempDir, "nested-child.jsonl");
    writeSessionTranscript(transcript, "nested-child-session");
    const runId = "completed-nested";
    const childRunId = "completed-nested-child";
    backend.registerWorkflow({ workflowId: runId, name: "nested-root", inputs: {}, createdAt: 1_000, updatedAt: 50_000, status: "completed" });
    const rootRun = { runId, runName: "nested-root" } as const;
    const childRun = { runId: childRunId, runName: "parallel-child", parentRunId: runId, parentStageId: "boundary", rootRunId: runId } as const;
    const childOutput = { workflow: "parallel-child", runId: childRunId, status: "completed", exited: false, outputs: { value: "ok" } } as const;
    for (const checkpoint of [
      { checkpointId: "root-before", name: "before", replayKey: "before", output: "before", topology: { version: 1 as const, stageId: "before", parentIds: [], run: rootRun } },
      { checkpointId: "root-boundary", name: "workflow:parallel-child", replayKey: "boundary", output: childOutput, topology: { version: 1 as const, stageId: "boundary", parentIds: ["before"], run: rootRun } },
      { checkpointId: "child-left", name: "left", replayKey: "child:left", output: "left", sessionFile: transcript, topology: { version: 1 as const, stageId: "left", parentIds: [], run: childRun } },
      { checkpointId: "child-right", name: "right", replayKey: "child:right", output: "right", topology: { version: 1 as const, stageId: "right", parentIds: [], run: childRun } },
      { checkpointId: "root-after", name: "after", replayKey: "after", output: "after", topology: { version: 1 as const, stageId: "after", parentIds: ["boundary"], run: rootRun } },
      // Prior resume attempts can leave terminal orphan child scopes and an unfinished
      // downstream stage whose parent source id predates cached-boundary replay.
      { checkpointId: "orphan-child", name: "orphan", replayKey: "old-child:orphan", output: "old", topology: { version: 1 as const, stageId: "orphan", parentIds: [], run: { ...childRun, runId: "old-child-run" } } },
      { checkpointId: "abandoned-after", name: "abandoned", replayKey: "abandoned", startedAt: 2_000, topology: { version: 1 as const, stageId: "abandoned", parentIds: ["old-boundary-id"], run: rootRun } },
    ]) {
      backend.recordCheckpoint({ kind: "stage", workflowId: runId, completedAt: 2_000, ...checkpoint });
    }
    backend.recordCheckpoint({
      kind: "tool", workflowId: runId, checkpointId: "run-timing:12345", name: "workflow-run-timing",
      argsHash: "workflow-run-timing", output: { elapsedMs: 12_345 }, completedAt: 3_000,
    });

    const entry = listCompletedFromBackend(backend)[0]!;
    const runs = completedWorkflowRunSnapshots(backend, entry);
    assert.equal(runs.length, 2);
    const root = runs.find((run) => run.id === runId)!;
    const childSnapshot = runs.find((run) => run.id === childRunId)!;
    assert.equal(childSnapshot.parentStageId, root.stages.find((stage) => stage.replayKey === "boundary")?.id);
    assert.equal(completedWorkflowSnapshot(backend, entry)?.durationMs, 12_345);
    const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, runId);
    assert.deepEqual(graph.stages.map((stage) => stage.name), ["before", "left", "right", "after"]);
    const before = graph.stages.find((stage) => stage.name === "before")!;
    const left = graph.stages.find((stage) => stage.name === "left")!;
    const right = graph.stages.find((stage) => stage.name === "right")!;
    const after = graph.stages.find((stage) => stage.name === "after")!;
    assert.deepEqual(left.parentIds, [before.id]);
    assert.deepEqual(right.parentIds, [before.id]);
    assert.deepEqual(new Set(after.parentIds), new Set([left.id, right.id]));
  });
});
