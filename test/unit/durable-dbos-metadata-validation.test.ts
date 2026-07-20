import { test } from "bun:test";
import assert from "node:assert/strict";
import { DbosDurableBackend, type DbosSdkHandle, type DbosStepRecord, type DbosWorkflowInfo } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

interface MockDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  readonly steps: Map<string, WorkflowSerializableValue>;
  readonly deletions: string[];
}

function createMockSdk(): DbosSdkHandle & { readonly state: MockDbosState } {
  const state: MockDbosState = { workflows: new Map(), steps: new Map(), deletions: [] };
  return {
    state,
    launch: async () => {},
    shutdown: async () => {},
    startWorkflow: async (workflowId, name, inputs) => {
      state.workflows.set(workflowId, { workflowId, name, status: "PENDING", createdAt: Date.now(), inputs });
    },
    retrieveWorkflow: async (workflowId) => state.workflows.get(workflowId),
    cancelWorkflow: async () => {},
    resumeWorkflow: async () => {},
    listAllWorkflows: async () => [...state.workflows.values()],
    listStepRecords: async (workflowId) => {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) records.push({ stepName: key.slice(prefix.length), output });
      }
      return records;
    },
    recordStepOutput: async (workflowId, stepName, output) => {
      state.steps.set(`${workflowId}:checkpoint:${stepName}`, output);
    },
    deleteWorkflowData: async (workflowId) => {
      state.deletions.push(workflowId);
      state.workflows.delete(workflowId);
    },
  };
}

test("DBOS hydration hides malformed and non-current metadata without mutating it", async () => {
  const sdk = createMockSdk();
  const session1 = new DbosDurableBackend(sdk);
  session1.registerWorkflow({ workflowId: "wf-meta-valid", name: "meta-valid", inputs: { x: 1 }, createdAt: 10, status: "running" });
  session1.recordCheckpoint({ kind: "tool", workflowId: "wf-meta-valid", checkpointId: "tool:valid", name: "meta-step", argsHash: "h-valid", output: "ok", completedAt: 11 });
  session1.setWorkflowStatus("wf-meta-valid", "paused");
  await session1.flush();
  const malformedMetadata: readonly WorkflowSerializableValue[] = [
    null,
    ["not", "metadata"],
    "not-metadata",
    { workflowId: 42, name: "bad", inputs: {}, status: "paused", completedCheckpoints: 9, pendingPrompts: 0 },
    { workflowId: "wf-meta-valid" },
  ];
  malformedMetadata.forEach((metadata, index) => {
    sdk.state.steps.set(`wf-meta-valid:checkpoint:__atomic_metadata:999999999999${index}:malformed`, {
      __atomicDurableMetadata: true,
      version: 3,
      metadata,
    });
  });
  sdk.state.steps.set("wf-meta-valid:checkpoint:__atomic_metadata:9999999999999:non-current", {
    __atomicDurableMetadata: true,
    version: 2,
    metadata: { workflowId: "wf-meta-valid" },
  });

  const fresh = new DbosDurableBackend(sdk);
  await fresh.hydrateResumableWorkflows();
  assert.equal(fresh.listResumableWorkflows().some((item) => item.workflowId === "wf-meta-valid"), false);
  assert.equal(fresh.getWorkflow("wf-meta-valid"), undefined);
  assert.deepEqual(sdk.state.deletions, []);
  assert.equal(sdk.state.workflows.has("wf-meta-valid"), true);
});
