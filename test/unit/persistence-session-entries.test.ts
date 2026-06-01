/**
 * Unit tests for shared/persistence-session-entries.ts
 * cross-ref: spec §5.6
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  appendRunStart,
  appendStageStart,
  appendStageProgress,
  appendStageEnd,
  appendRunEnd,
} from "../../packages/workflows/src/shared/persistence-session-entries.js";
import type { PersistenceAPI } from "../../packages/workflows/src/shared/persistence-session-entries.js";

// ---------------------------------------------------------------------------
// Mock PersistenceAPI
// ---------------------------------------------------------------------------

interface AppendedEntry {
  type: string;
  payload: Record<string, unknown>;
}

function makeMockApi(): PersistenceAPI & {
  _entries: AppendedEntry[];
  _labels: Map<string, string>;
  _messages: string[];
  _entryCounter: number;
} {
  const _entries: AppendedEntry[] = [];
  const _labels = new Map<string, string>();
  const _messages: string[] = [];
  let _entryCounter = 0;

  return {
    _entries,
    _labels,
    _messages,
    get _entryCounter() { return _entryCounter; },
    appendEntry(type: string, payload: Record<string, unknown>): string {
      _entries.push({ type, payload });
      return `entry-${_entryCounter++}`;
    },
    setLabel(entryId: string, label: string): void {
      _labels.set(entryId, label);
    },
    appendCustomMessageEntry(content: string, meta?: Record<string, unknown>): string {
      _messages.push(content);
      void meta;
      return `msg-${_entryCounter++}`;
    },
  };
}

// ---------------------------------------------------------------------------
// appendRunStart
// ---------------------------------------------------------------------------

describe("appendRunStart", () => {
  test("calls appendEntry with workflow.run.start type", () => {
    const api = makeMockApi();
    appendRunStart(api, { runId: "abc-123", name: "my-wf", inputs: {}, ts: 1000 });
    assert.equal(api._entries.length, 1);
    assert.equal(api._entries[0]!.type, "workflow.run.start");
  });

  test("payload contains runId, name, inputs, ts", () => {
    const api = makeMockApi();
    appendRunStart(api, { runId: "r1", name: "wf", inputs: { x: 1 }, ts: 42 });
    const p = api._entries[0]!.payload;
    assert.equal(p["runId"], "r1");
    assert.equal(p["name"], "wf");
    assert.equal(p["ts"], 42);
    assert.equal((p["inputs"] as Record<string, unknown>)["x"], 1);
  });

  test("calls setLabel with wf:<name>:<short-id> format", () => {
    const api = makeMockApi();
    appendRunStart(api, { runId: "abcdefgh-1234", name: "my-workflow", inputs: {}, ts: 1 });
    assert.equal(api._labels.size, 1);
    const label = [...api._labels.values()][0];
    assert.equal(label, "wf:my-workflow:abcdefgh");
  });

  test("includes continuation metadata when provided", () => {
    const api = makeMockApi();
    appendRunStart(api, {
      runId: "r2",
      name: "wf",
      inputs: {},
      resumedFromRunId: "r1",
      resumeFromStageId: "s2",
      ts: 1,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["resumedFromRunId"], "r1");
    assert.equal(p["resumeFromStageId"], "s2");
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    // Should not throw
    appendRunStart(api, { runId: "r1", name: "wf", inputs: {}, ts: 1 });
  });

  test("no setLabel when setLabel absent", () => {
    const _entries: AppendedEntry[] = [];
    const api: PersistenceAPI = {
      appendEntry(type, payload) {
        _entries.push({ type, payload });
        return "eid";
      },
      // setLabel intentionally absent
    };
    // Should not throw
    appendRunStart(api, { runId: "r1", name: "wf", inputs: {}, ts: 1 });
    assert.equal(_entries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// appendStageStart
// ---------------------------------------------------------------------------

describe("appendStageStart", () => {
  test("calls appendEntry with workflow.stage.start type", () => {
    const api = makeMockApi();
    appendStageStart(api, {
      runId: "r1",
      stageId: "s1",
      name: "fetch",
      parentIds: [],
      ts: 100,
    });
    assert.equal(api._entries[0]!.type, "workflow.stage.start");
  });

  test("payload contains all required fields", () => {
    const api = makeMockApi();
    appendStageStart(api, {
      runId: "r1",
      stageId: "s2",
      name: "analyze",
      parentIds: ["s1"],
      model: "sonnet",
      ts: 200,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["runId"], "r1");
    assert.equal(p["stageId"], "s2");
    assert.equal(p["name"], "analyze");
    assert.deepEqual(p["parentIds"], ["s1"]);
    assert.equal(p["model"], "sonnet");
    assert.equal(p["ts"], 200);
  });

  test("model omitted when not provided", () => {
    const api = makeMockApi();
    appendStageStart(api, { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 1 });
    assert.equal("model" in api._entries[0]!.payload, false);
  });

  test("includes replay metadata when provided", () => {
    const api = makeMockApi();
    appendStageStart(api, {
      runId: "r2",
      stageId: "s-new",
      name: "first",
      parentIds: [],
      replayKey: "prompt:confirm:abc:1",
      replayedFromStageId: "s-old",
      replayed: true,
      ts: 1,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["replayKey"], "prompt:confirm:abc:1");
    assert.equal(p["replayedFromStageId"], "s-old");
    assert.equal(p["replayed"], true);
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendStageStart(api, { runId: "r1", stageId: "s1", name: "n", parentIds: [], ts: 1 });
  });
});

// ---------------------------------------------------------------------------
// appendStageProgress
// ---------------------------------------------------------------------------

describe("appendStageProgress", () => {
  test("calls appendEntry with workflow.stage.progress type", () => {
    const api = makeMockApi();
    appendStageProgress(api, { runId: "r1", stageId: "s1", kind: "tool_call", payload: { tool: "read_file" } });
    assert.equal(api._entries[0]!.type, "workflow.stage.progress");
  });

  test("payload contains kind", () => {
    const api = makeMockApi();
    appendStageProgress(api, { runId: "r1", stageId: "s1", kind: "message_delta", payload: "hello" });
    assert.equal(api._entries[0]!.payload["kind"], "message_delta");
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendStageProgress(api, { runId: "r1", stageId: "s1", kind: "k", payload: {} });
  });
});

// ---------------------------------------------------------------------------
// appendStageEnd
// ---------------------------------------------------------------------------

describe("appendStageEnd", () => {
  test("calls appendEntry with workflow.stage.end type", () => {
    const api = makeMockApi();
    appendStageEnd(api, { runId: "r1", stageId: "s1", status: "completed" });
    assert.equal(api._entries[0]!.type, "workflow.stage.end");
  });

  test("includes durationMs and summary when provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, { runId: "r1", stageId: "s1", status: "completed", durationMs: 500, summary: "done" });
    const p = api._entries[0]!.payload;
    assert.equal(p["durationMs"], 500);
    assert.equal(p["summary"], "done");
  });

  test("omits durationMs/summary when not provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, { runId: "r1", stageId: "s1", status: "failed" });
    const p = api._entries[0]!.payload;
    assert.equal("durationMs" in p, false);
    assert.equal("summary" in p, false);
  });

  test("includes optional failure metadata when provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, {
      runId: "r1",
      stageId: "s1",
      status: "failed",
      error: "login required",
      failureKind: "auth",
      failureMessage: "No API key found",
      skippedReason: "fail-fast",
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["error"], "login required");
    assert.equal(p["failureKind"], "auth");
    assert.equal(p["failureMessage"], "No API key found");
    assert.equal(p["skippedReason"], "fail-fast");
  });

  test("includes optional replay metadata when provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, {
      runId: "r2",
      stageId: "s-new",
      status: "completed",
      summary: "old result",
      replayKey: "prompt:confirm:abc:1",
      replayedFromStageId: "s-old",
      replayed: true,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["summary"], "old result");
    assert.equal(p["replayKey"], "prompt:confirm:abc:1");
    assert.equal(p["replayedFromStageId"], "s-old");
    assert.equal(p["replayed"], true);
  });

  test("includes optional workflow child replay metadata when provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, {
      runId: "r2",
      stageId: "s-new",
      status: "completed",
      workflowChild: {
        alias: "child",
        workflow: "child-wf",
        runId: "child-run",
        status: "completed",
        outputs: { summary: "ok" },
      },
    });
    const p = api._entries[0]!.payload;
    assert.deepEqual(p["workflowChild"], {
      alias: "child",
      workflow: "child-wf",
      runId: "child-run",
      status: "completed",
      outputs: { summary: "ok" },
    });
  });

  test("emitMessage=true calls appendCustomMessageEntry when summary provided", () => {
    const api = makeMockApi();
    appendStageEnd(
      api,
      { runId: "r1", stageId: "s1", status: "completed", summary: "fetched 10 files" },
      { emitMessage: true },
    );
    assert.equal(api._messages.length, 1);
    assert.ok(api._messages[0].includes("fetched 10 files"));
  });

  test("emitMessage=true does NOT call appendCustomMessageEntry when summary absent", () => {
    const api = makeMockApi();
    appendStageEnd(api, { runId: "r1", stageId: "s1", status: "completed" }, { emitMessage: true });
    assert.equal(api._messages.length, 0);
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendStageEnd(api, { runId: "r1", stageId: "s1", status: "completed" });
  });
});

// ---------------------------------------------------------------------------
// appendRunEnd
// ---------------------------------------------------------------------------

describe("appendRunEnd", () => {
  test("calls appendEntry with workflow.run.end type", () => {
    const api = makeMockApi();
    appendRunEnd(api, { runId: "r1", status: "completed", ts: 999 });
    assert.equal(api._entries[0]!.type, "workflow.run.end");
  });

  test("payload contains runId, status, ts", () => {
    const api = makeMockApi();
    appendRunEnd(api, { runId: "r1", status: "failed", ts: 123 });
    const p = api._entries[0]!.payload;
    assert.equal(p["runId"], "r1");
    assert.equal(p["status"], "failed");
    assert.equal(p["ts"], 123);
  });

  test("includes result when provided", () => {
    const api = makeMockApi();
    appendRunEnd(api, { runId: "r1", status: "completed", result: { out: 42 }, ts: 1 });
    assert.equal((api._entries[0]!.payload["result"] as Record<string, unknown>)["out"], 42);
  });

  test("includes optional run failure metadata when provided", () => {
    const api = makeMockApi();
    appendRunEnd(api, {
      runId: "r1",
      status: "failed",
      error: "login required",
      failureKind: "auth",
      failureMessage: "No API key found",
      failedStageId: "s1",
      resumable: true,
      ts: 1,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["error"], "login required");
    assert.equal(p["failureKind"], "auth");
    assert.equal(p["failureMessage"], "No API key found");
    assert.equal(p["failedStageId"], "s1");
    assert.equal(p["resumable"], true);
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendRunEnd(api, { runId: "r1", status: "completed", ts: 1 });
  });
});
