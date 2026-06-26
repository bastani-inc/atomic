/**
 * Tests for durable backend factory default persistence and durable cache
 * session-log persistence.
 *
 * Verifies that cross-session file persistence is always enabled by default
 * under ~/.atomic, while tests may still inject a non-persistent in-memory
 * backend explicitly.
 *
 * cross-ref: issue #1498 — durable state cached on the session file.
 */
import { describe, test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { FileDurableBackend, WorkflowFileDurableBackend, defaultDurableStateDir, durableStateFileFor } from "../../packages/workflows/src/durable/file-backend.js";
import { persistDurableCacheEntry } from "../../packages/workflows/src/durable/resume-catalog.js";
import type { DurableCheckpointEntry } from "../../packages/workflows/src/durable/types.js";

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(name: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
}

function setEnv(name: string, value: string | undefined): void {
  saveEnv(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(savedEnv)) delete savedEnv[name];
}

describe("durable backend factory (default cross-session persistence)", () => {
  afterEach(() => {
    setDurableBackend(undefined);
    restoreEnv();
  });

  test("default backend is per-workflow file-backed and persistent under ~/.atomic without opt-in env vars", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "atomic-durable-home-"));
    setEnv("HOME", tmpHome);
    setEnv("USERPROFILE", undefined);
    setEnv("DBOS_SYSTEM_DATABASE_URL", undefined);
    setEnv("ATOMIC_WORKFLOW_DURABLE", undefined);
    try {
      setDurableBackend(undefined);
      const backend = getDurableBackend();
      assert.equal(backend.persistent, true);
      assert.ok(backend instanceof WorkflowFileDurableBackend);
      const stateDir = defaultDurableStateDir();
      assert.equal(stateDir, `${tmpHome}/.atomic/workflow-durable`);

      backend.registerWorkflow({ workflowId: "wf-default-persist", name: "default-persist", inputs: {}, createdAt: 1, status: "running" });
      backend.setWorkflowStatus("wf-default-persist", "failed");
      assert.ok(stateDir !== undefined);
      assert.equal(existsSync(durableStateFileFor(stateDir, "wf-default-persist")), true);
      assert.equal(existsSync(join(stateDir, "state.json")), false);

      setDurableBackend(undefined);
      const backend2 = getDurableBackend();
      const resumable = backend2.listResumableWorkflows();
      assert.equal(resumable.length, 1);
      assert.equal(resumable[0]!.workflowId, "wf-default-persist");
      assert.equal(resumable[0]!.status, "failed");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("durability opt-out uses in-memory backend", () => {
    setEnv("ATOMIC_WORKFLOW_DURABLE", "0");
    setDurableBackend(undefined);
    const backend = getDurableBackend();
    assert.equal(backend.persistent, false);
    assert.ok(backend instanceof InMemoryDurableBackend);
  });

  test("missing home directory fails closed to in-memory backend", () => {
    setEnv("HOME", undefined);
    setEnv("USERPROFILE", undefined);
    setEnv("ATOMIC_WORKFLOW_DURABLE", undefined);
    setDurableBackend(undefined);
    assert.equal(defaultDurableStateDir(), undefined);
    const backend = getDurableBackend();
    assert.equal(backend.persistent, false);
    assert.ok(backend instanceof InMemoryDurableBackend);
  });
});

describe("durable cache session-log persistence", () => {
  test("explicit in-memory backend remains non-persistent for isolated tests", () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-1", name: "test", inputs: {}, createdAt: 1, status: "running" });
    const appended: string[] = [];
    const persistence = {
      appendEntry: (type: string) => { appended.push(type); return "id"; },
    };
    const entry = backend.toCacheEntry("wf-1")!;
    assert.equal(backend.persistent, false);
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
