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
  appendRunBlocked,
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
      failureCode: "missing_api_key",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      failureMessage: "No API key found",
      retryAfterMs: 5000,
      skippedReason: "fail-fast",
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["error"], "login required");
    assert.equal(p["failureKind"], "auth");
    assert.equal(p["failureCode"], "missing_api_key");
    assert.equal(p["failureRecoverability"], "recoverable");
    assert.equal(p["failureDisposition"], "active_blocked");
    assert.equal(p["failureMessage"], "No API key found");
    assert.equal(p["retryAfterMs"], 5000);
    assert.equal(p["skippedReason"], "fail-fast");
  });

  test("includes optional session metadata when provided", () => {
    const api = makeMockApi();
    appendStageEnd(api, {
      runId: "r1",
      stageId: "s1",
      status: "failed",
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["sessionId"], "session-1");
    assert.equal(p["sessionFile"], "/tmp/session-1.jsonl");
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

  test("omits workflow child replay metadata for non-completed stage ends", () => {
    const workflowChild = {
      alias: "child",
      workflow: "child-wf",
      runId: "child-run",
      status: "completed" as const,
      outputs: { summary: "stale" },
    };
    for (const status of ["skipped", "failed"] as const) {
      const api = makeMockApi();
      appendStageEnd(api, {
        runId: "r2",
        stageId: `${status}-boundary`,
        status,
        workflowChild,
      });
      assert.equal("workflowChild" in api._entries[0]!.payload, false);
    }
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
      failureCode: "invalid_api_key",
      failureRecoverability: "non_recoverable",
      failureDisposition: "terminal_killed",
      failureMessage: "No API key found",
      failedStageId: "s1",
      resumable: false,
      retryAfterMs: 7000,
      ts: 1,
    });
    const p = api._entries[0]!.payload;
    assert.equal(p["error"], "login required");
    assert.equal(p["failureKind"], "auth");
    assert.equal(p["failureCode"], "invalid_api_key");
    assert.equal(p["failureRecoverability"], "non_recoverable");
    assert.equal(p["failureDisposition"], "terminal_killed");
    assert.equal(p["failureMessage"], "No API key found");
    assert.equal(p["failedStageId"], "s1");
    assert.equal(p["resumable"], false);
    assert.equal(p["retryAfterMs"], 7000);
  });

  test("strips active-blocked disposition from terminal failed run.end payloads", () => {
    const api = makeMockApi();
    appendRunEnd(api, {
      runId: "r1",
      status: "failed",
      error: "too many requests",
      failureKind: "rate_limit",
      failureCode: "rate_limited",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      failureMessage: "too many requests",
      failedStageId: "s1",
      resumable: true,
      retryAfterMs: 1000,
      ts: 1,
    });

    const p = api._entries[0]!.payload;
    assert.equal(p["status"], "failed");
    assert.equal(p["failureKind"], "rate_limit");
    assert.equal(p["failureCode"], "rate_limited");
    assert.equal(p["failureRecoverability"], "recoverable");
    assert.equal("failureDisposition" in p, false);
    assert.equal(p["resumable"], true);
    assert.equal(p["retryAfterMs"], 1000);
  });

  test("normalizes killed run.end payloads to terminal-killed and non-resumable", () => {
    const api = makeMockApi();
    appendRunEnd(api, {
      runId: "r1",
      status: "killed",
      error: "workflow killed",
      failureKind: "cancelled",
      failureCode: "cancelled",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      failureMessage: "workflow killed",
      resumable: true,
      ts: 1,
    });

    const p = api._entries[0]!.payload;
    assert.equal(p["status"], "killed");
    assert.equal(p["failureRecoverability"], "non_recoverable");
    assert.equal(p["failureDisposition"], "terminal_killed");
    assert.equal(p["resumable"], false);
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendRunEnd(api, { runId: "r1", status: "completed", ts: 1 });
  });
});

// ---------------------------------------------------------------------------
// appendRunBlocked
// ---------------------------------------------------------------------------

describe("appendRunBlocked", () => {
  test("calls appendEntry with workflow.run.blocked type and metadata", () => {
    const api = makeMockApi();
    appendRunBlocked(api, {
      runId: "r1",
      failedStageId: "s1",
      error: "rate limit",
      failureKind: "rate_limit",
      failureCode: "rate_limited",
      failureMessage: "HTTP 429",
      failureRecoverability: "recoverable",
      failureDisposition: "active_blocked",
      retryAfterMs: 2500,
      resumable: true,
      ts: 123,
    });

    assert.equal(api._entries[0]!.type, "workflow.run.blocked");
    const p = api._entries[0]!.payload;
    assert.equal(p["runId"], "r1");
    assert.equal(p["failedStageId"], "s1");
    assert.equal(p["error"], "rate limit");
    assert.equal(p["failureKind"], "rate_limit");
    assert.equal(p["failureCode"], "rate_limited");
    assert.equal(p["failureMessage"], "HTTP 429");
    assert.equal(p["failureRecoverability"], "recoverable");
    assert.equal(p["failureDisposition"], "active_blocked");
    assert.equal(p["retryAfterMs"], 2500);
    assert.equal(p["resumable"], true);
    assert.equal(p["ts"], 123);
  });

  test("no-op when appendEntry absent", () => {
    const api: PersistenceAPI = {};
    appendRunBlocked(api, {
      runId: "r1",
      failedStageId: "s1",
      error: "rate limit",
      failureKind: "rate_limit",
      failureRecoverability: "recoverable",
      resumable: true,
      ts: 1,
    });
  });
});
