/**
 * Tests for the DBOS-backed durable backend adapter.
 *
 * Since the real DBOS SDK requires Postgres, these tests use a mock
 * {@link DbosSdkHandle} to verify the adapter correctly delegates to DBOS
 * primitives while keeping an in-memory mirror for synchronous queries.
 *
 * cross-ref: issue #1498 — DBOS TypeScript SDK integration.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { DbosDurableBackend, isDbosConfigured } from "../../packages/workflows/src/durable/dbos-backend.js";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import type { DbosSdkHandle } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";

interface MockDbosCalls {
  starts: { workflowId: string; name: string }[];
  cancels: string[];
  resumes: string[];
  stepOutputs: { workflowId: string; stepName: string; output: unknown }[];
}

function createMockSdk(): DbosSdkHandle & { calls: MockDbosCalls } {
  const calls: MockDbosCalls = { starts: [], cancels: [], resumes: [], stepOutputs: [] };
  return {
    calls,
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name) { calls.starts.push({ workflowId, name }); },
    async retrieveWorkflow() { return undefined; },
    async cancelWorkflow(workflowId) { calls.cancels.push(workflowId); },
    async resumeWorkflow(workflowId) { calls.resumes.push(workflowId); },
    async listPendingWorkflows() { return []; },
    async recordStepOutput(workflowId, stepName, output) { calls.stepOutputs.push({ workflowId, stepName, output }); },
    async getStepOutput() { return undefined; },
  };
}

describe("DbosDurableBackend (mock SDK)", () => {
  let sdk: ReturnType<typeof createMockSdk>;
  let backend: DbosDurableBackend;

  beforeEach(() => {
    sdk = createMockSdk();
    backend = new DbosDurableBackend(sdk);
  });

  test("registerWorkflow delegates to DBOS startWorkflow", () => {
    backend.registerWorkflow({
      workflowId: "wf-dbos-1",
      name: "dbos-workflow",
      inputs: { task: "analyze" },
      createdAt: Date.now(),
      status: "running",
    });
    assert.equal(sdk.calls.starts.length, 1);
    assert.equal(sdk.calls.starts[0]!.workflowId, "wf-dbos-1");
    assert.equal(sdk.calls.starts[0]!.name, "dbos-workflow");
    // In-memory mirror also has the workflow.
    assert.equal(backend.getWorkflow("wf-dbos-1")!.name, "dbos-workflow");
  });

  test("recordCheckpoint delegates to DBOS recordStepOutput", () => {
    backend.registerWorkflow({ workflowId: "wf-2", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const cp: DurableCheckpoint = {
      kind: "tool",
      workflowId: "wf-2",
      checkpointId: "cp-1",
      name: "fetch-data",
      argsHash: durableHash({ name: "fetch", args: {} }),
      output: "result",
      completedAt: Date.now(),
    };
    backend.recordCheckpoint(cp);
    assert.equal(sdk.calls.stepOutputs.length, 1);
    assert.equal(sdk.calls.stepOutputs[0]!.workflowId, "wf-2");
    assert.equal(sdk.calls.stepOutputs[0]!.output, "result");
  });

  test("cancelWorkflow delegates to DBOS cancelWorkflow", () => {
    backend.registerWorkflow({ workflowId: "wf-3", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    backend.setWorkflowStatus("wf-3", "cancelled");
    assert.equal(sdk.calls.cancels.length, 1);
    assert.equal(sdk.calls.cancels[0], "wf-3");
    assert.equal(backend.getWorkflow("wf-3")!.status, "cancelled");
  });

  test("resume sets running status and delegates to DBOS resumeWorkflow", () => {
    backend.registerWorkflow({ workflowId: "wf-4", name: "test", inputs: {}, createdAt: Date.now(), status: "paused" });
    backend.setWorkflowStatus("wf-4", "running");
    assert.equal(sdk.calls.resumes.length, 1);
    assert.equal(sdk.calls.resumes[0], "wf-4");
    assert.equal(backend.getWorkflow("wf-4")!.status, "running");
  });

  test("getToolOutput reads from in-memory mirror", () => {
    backend.registerWorkflow({ workflowId: "wf-5", name: "test", inputs: {}, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "compute", args: { x: 1 } });
    backend.recordCheckpoint({
      kind: "tool", workflowId: "wf-5", checkpointId: "cp-1", name: "compute", argsHash: hash, output: 42, completedAt: Date.now(),
    });
    assert.equal(backend.getToolOutput("wf-5", hash), 42);
  });
});

describe("isDbosConfigured", () => {
  test("returns false when DBOS_SYSTEM_DATABASE_URL is not set", () => {
    const saved = process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    assert.equal(isDbosConfigured(), false);
    if (saved) process.env.DBOS_SYSTEM_DATABASE_URL = saved;
  });

  test("returns true when DBOS_SYSTEM_DATABASE_URL is set", () => {
    const saved = process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://localhost/test";
    assert.equal(isDbosConfigured(), true);
    if (saved) process.env.DBOS_SYSTEM_DATABASE_URL = saved;
    else delete process.env.DBOS_SYSTEM_DATABASE_URL;
  });
});

describe("InMemoryDurableBackend export/import round-trip", () => {
  test("exportAll + importAll preserves all checkpoints", () => {
    const src = new InMemoryDurableBackend();
    src.registerWorkflow({ workflowId: "wf-exp", name: "export-test", inputs: { a: 1 }, createdAt: Date.now(), status: "running" });
    const hash = durableHash({ name: "t", args: {} });
    src.recordCheckpoint({ kind: "tool", workflowId: "wf-exp", checkpointId: "cp-1", name: "t", argsHash: hash, output: "val", completedAt: Date.now() });

    const dst = new InMemoryDurableBackend();
    dst.importAll(src.exportAll());
    assert.equal(dst.getToolOutput("wf-exp", hash), "val");
    assert.equal(dst.getWorkflow("wf-exp")!.completedCheckpoints, 1);
  });
});
