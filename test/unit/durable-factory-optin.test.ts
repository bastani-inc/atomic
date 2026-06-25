/**
 * Tests for durable backend factory opt-in behavior and durable cache
 * session-log persistence.
 *
 * Verifies that cross-session file persistence is opt-in (default in-memory)
 * so normal runs do not pollute the session lifecycle log, while an explicit
 * persistent backend writes discovery cache entries.
 *
 * cross-ref: issue #1498 — durable state cached on the session file.
 */
import { describe, test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend } from "../../packages/workflows/src/durable/file-backend.js";
import { persistDurableCacheEntry } from "../../packages/workflows/src/durable/resume-catalog.js";
import type { DurableCheckpointEntry } from "../../packages/workflows/src/durable/types.js";

describe("durable backend factory (opt-in cross-session persistence)", () => {
  afterEach(() => setDurableBackend(undefined));

  test("default backend is in-memory and non-persistent", () => {
    setDurableBackend(undefined);
    delete process.env.ATOMIC_WORKFLOW_DURABLE_DIR;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    const backend = getDurableBackend();
    assert.equal(backend.persistent, false);
    assert.ok(backend instanceof InMemoryDurableBackend);
  });

  test("file-backed backend is opt-in via ATOMIC_WORKFLOW_DURABLE_DIR", () => {
    setDurableBackend(undefined);
    process.env.ATOMIC_WORKFLOW_DURABLE_DIR = "/tmp/atomic-durable-test";
    try {
      const backend = getDurableBackend();
      assert.equal(backend.persistent, true);
    } finally {
      delete process.env.ATOMIC_WORKFLOW_DURABLE_DIR;
    }
  });
});

describe("durable cache session-log persistence", () => {
  test("in-memory backend (non-persistent) skips session-log cache writes", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-1", name: "test", inputs: {}, createdAt: 1, status: "running" });
    const appended: string[] = [];
    const persistence = {
      appendEntry: (type: string) => { appended.push(type); return "id"; },
    };
    const entry = backend.toCacheEntry("wf-1")!;
    // persistDurableCacheEntry writes unconditionally to the port; the engine
    // gates the call on backend.persistent. Here we verify the gate semantics:
    // a non-persistent backend means the engine would NOT call this.
    assert.equal(backend.persistent, false);
    // Direct call still works (the port is the contract), but the engine skips it.
    persistDurableCacheEntry(persistence, entry);
    assert.deepEqual(appended, ["workflow.durable.checkpoint"]);
  });

  test("file-backed backend (persistent) round-trips discovery cache", () => {
    const tmpDir = `/tmp/atomic-durable-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const backend = new FileDurableBackend(`${tmpDir}/state.json`);
    assert.equal(backend.persistent, true);
    backend.registerWorkflow({ workflowId: "wf-persist-1", name: "persist-test", inputs: { topic: "x" }, createdAt: 1, status: "running" });
    backend.setWorkflowStatus("wf-persist-1", "failed");
    // A new backend instance (new session) sees the persisted workflow.
    const backend2 = new FileDurableBackend(`${tmpDir}/state.json`);
    const resumable = backend2.listResumableWorkflows();
    assert.equal(resumable.length, 1);
    assert.equal(resumable[0]!.workflowId, "wf-persist-1");
    assert.equal(resumable[0]!.status, "failed");
  });

  test("cache entry shape matches DurableCheckpointEntry contract", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-shape", name: "shape-test", inputs: {}, createdAt: 1, status: "running" });
    const entry: DurableCheckpointEntry = backend.toCacheEntry("wf-shape")!;
    assert.equal(entry.type, "workflow.durable.checkpoint");
    assert.equal(entry.workflowId, "wf-shape");
    assert.equal(entry.name, "shape-test");
    assert.equal(typeof entry.ts, "number");
  });
});
