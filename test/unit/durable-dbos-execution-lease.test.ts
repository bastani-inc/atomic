import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbosDurableBackend, type DbosSdkHandle, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

function mockSdk(): DbosSdkHandle {
  const workflows = new Map<string, DbosWorkflowInfo>();
  const steps = new Map<string, WorkflowSerializableValue>();
  return {
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name, inputs) {
      workflows.set(workflowId, { workflowId, name, inputs, status: "PENDING", createdAt: Date.now() });
    },
    async retrieveWorkflow(workflowId) { return workflows.get(workflowId); },
    async cancelWorkflow() {},
    async resumeWorkflow() {},
    async listAllWorkflows() { return [...workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:`;
      return [...steps].filter(([key]) => key.startsWith(prefix)).map(([key, output]) => ({ stepName: key.slice(prefix.length), output }));
    },
    async recordStepOutput(workflowId, stepName, output) { steps.set(`${workflowId}:${stepName}`, output); },
  };
}

test("DBOS backends share duplicate-dispatch execution leases", async () => {
  const leaseDir = mkdtempSync(join(tmpdir(), "dbos-execution-lease-"));
  try {
    const sdk = mockSdk();
    const owner = new DbosDurableBackend(sdk, leaseDir);
    const contender = new DbosDurableBackend(sdk, leaseDir);
    owner.registerWorkflow({ workflowId: "wf-dbos-owned", name: "owned", inputs: {}, createdAt: 1, status: "running" });
    owner.recordCheckpoint({ kind: "tool", workflowId: "wf-dbos-owned", checkpointId: "ready", name: "ready", argsHash: "h-ready", output: "ready", completedAt: 2 });
    await owner.flush();
    await contender.hydrateWorkflow("wf-dbos-owned");

    assert.equal(owner.claimWorkflowExecution("wf-dbos-owned"), true);
    assert.equal(contender.claimWorkflowExecution("wf-dbos-owned"), false);
    assert.equal(contender.listResumableWorkflows().some((entry) => entry.workflowId === "wf-dbos-owned"), false);

    owner.setWorkflowStatus("wf-dbos-owned", "paused", undefined, true);
    await owner.flush();
    assert.equal(contender.claimWorkflowExecution("wf-dbos-owned"), true);
  } finally {
    rmSync(leaseDir, { recursive: true, force: true });
  }
});
