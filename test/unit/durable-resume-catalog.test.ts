/**
 * Tests for cross-session resume catalog and durable cache entry persistence.
 *
 * cross-ref: issue #1498 — `/workflow resume` selector behavior and
 * cross-session resume metadata.
 */
import { describe, test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  scanResumableWorkflows,
  persistDurableCacheEntry,
  formatResumableWorkflowList,
  listResumableFromBackend,
} from "../../packages/workflows/src/durable/resume-catalog.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DurableCheckpointEntry } from "../../packages/workflows/src/durable/types.js";

function makeEntry(workflowId: string, name: string, status: string, ts: number): DurableCheckpointEntry {
  return {
    formatVersion: 2,
    type: "workflow.durable.checkpoint",
    workflowId,
    name,
    inputs: {},
    status: status as DurableCheckpointEntry["status"],
    completedCheckpoints: 3,
    pendingPrompts: 0,
    ts,
  };
}

describe("scanResumableWorkflows (session JSONL scanning)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resume-cat-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("reads durable checkpoint entries from session JSONL files", () => {
    const sessionFile = join(tmpDir, "session-001.jsonl");
    const entry = makeEntry("wf-aaa", "research-workflow", "paused", Date.now());
    writeFileSync(sessionFile, JSON.stringify({ type: "workflow.run.start", runId: "wf-aaa" }) + "\n");
    writeFileSync(sessionFile, JSON.stringify(entry) + "\n", { flag: "a" });

    const result = scanResumableWorkflows(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.workflowId, "wf-aaa");
    assert.equal(result[0]!.name, "research-workflow");
    assert.equal(result[0]!.status, "paused");
    assert.equal(result[0]!.sessionFile, sessionFile);
  });

  test("reads Atomic custom-entry durable checkpoint shape", () => {
    const sessionFile = join(tmpDir, "session-custom.jsonl");
    const entry = makeEntry("wf-custom", "custom-shape", "paused", Date.now());
    writeFileSync(sessionFile, JSON.stringify({ type: "custom", customType: "workflow.durable.checkpoint", data: entry }) + "\n");

    const result = scanResumableWorkflows(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.workflowId, "wf-custom");
    assert.equal(result[0]!.name, "custom-shape");
    assert.equal(result[0]!.status, "paused");
  });

  test("excludes completed and cancelled workflows, includes running (crash recovery) and paused", () => {
    const sessionFile = join(tmpDir, "session-002.jsonl");
    const lines = [
      JSON.stringify(makeEntry("wf-completed", "done", "completed", Date.now())),
      JSON.stringify(makeEntry("wf-cancelled", "aborted", "cancelled", Date.now())),
      JSON.stringify(makeEntry("wf-running", "active", "running", Date.now())),
      JSON.stringify(makeEntry("wf-paused", "inactive", "paused", Date.now())),
      JSON.stringify(makeEntry("wf-failed", "errored", "failed", Date.now())),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    const result = scanResumableWorkflows(tmpDir);
    const ids = result.map((e) => e.workflowId);
    assert.ok(!ids.includes("wf-completed"));
    assert.ok(!ids.includes("wf-cancelled"));
    assert.ok(ids.includes("wf-running"), "running durable workflows are resumable (crash recovery)");
    assert.ok(ids.includes("wf-paused"));
    assert.ok(ids.includes("wf-failed"));
  });

  test("returns most recently updated first", () => {
    const sessionFile = join(tmpDir, "session-003.jsonl");
    const t0 = Date.now();
    const lines = [
      JSON.stringify(makeEntry("wf-old", "old-workflow", "paused", t0 - 5000)),
      JSON.stringify(makeEntry("wf-new", "new-workflow", "paused", t0)),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n");

    const result = scanResumableWorkflows(tmpDir);
    assert.equal(result[0]!.workflowId, "wf-new");
    assert.equal(result[1]!.workflowId, "wf-old");
  });

  test("handles empty directory gracefully", () => {
    assert.deepEqual(scanResumableWorkflows(tmpDir), []);
  });

  test("handles non-existent directory gracefully", () => {
    assert.deepEqual(scanResumableWorkflows(join(tmpDir, "does-not-exist")), []);
  });

  test("handles malformed JSONL lines gracefully", () => {
    const sessionFile = join(tmpDir, "session-malformed.jsonl");
    const entry = makeEntry("wf-good", "good", "paused", Date.now());
    writeFileSync(sessionFile, "not-json\n" + JSON.stringify(entry) + "\n{bad json\n");

    const result = scanResumableWorkflows(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.workflowId, "wf-good");
  });
});

describe("persistDurableCacheEntry", () => {
  test("appends workflow.durable.checkpoint entry via persistence port", () => {
    const appended: { type: string; payload: Record<string, unknown> }[] = [];
    const persistence = {
      appendEntry: (type: string, payload: Record<string, unknown>) => {
        appended.push({ type, payload });
        return "entry-id";
      },
    };
    const entry = makeEntry("wf-test", "test-workflow", "running", Date.now());
    persistDurableCacheEntry(persistence, entry);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]!.type, "workflow.durable.checkpoint");
    assert.equal(appended[0]!.payload["workflowId"], "wf-test");
  });

  test("no-ops when persistence port lacks appendEntry", () => {
    const entry = makeEntry("wf-test", "test", "running", Date.now());
    persistDurableCacheEntry({}, entry); // should not throw
  });
});

describe("listResumableFromBackend", () => {
  test("lists resumable workflows from an in-memory backend", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-1", name: "alpha", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-2", name: "beta", inputs: {}, createdAt: Date.now(), status: "paused", completedCheckpoints: 1 });
    backend.registerWorkflow({ workflowId: "wf-3", name: "gamma", inputs: {}, createdAt: Date.now(), status: "completed" });

    const result = listResumableFromBackend(backend);
    assert.equal(result.length, 2);
    const ids = result.map((e) => e.workflowId);
    assert.ok(ids.includes("wf-1"));
    assert.ok(ids.includes("wf-2"));
    assert.ok(!ids.includes("wf-3"));
  });
});

describe("formatResumableWorkflowList", () => {
  test("formats entries for selector display", () => {
    const entries = [
      { workflowId: "abcdefgh1234", name: "research", status: "paused" as const, completedCheckpoints: 5, pendingPrompts: 0, createdAt: Date.now(), updatedAt: Date.now() },
    ];
    const text = formatResumableWorkflowList(entries);
    assert.ok(text.includes("abcdefgh"));
    assert.ok(text.includes("research"));
    assert.ok(text.includes("5 checkpoints"));
  });

  test("handles empty list", () => {
    assert.ok(formatResumableWorkflowList([]).includes("No resumable"));
  });
});
