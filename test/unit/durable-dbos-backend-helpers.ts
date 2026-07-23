/**
 * Shared mock DBOS SDK helpers for durable DBOS backend tests.
 *
 * Since the real DBOS SDK requires Postgres, these helpers provide a mock
 * {@link DbosSdkHandle} that simulates DBOS persistence. The mock stores
 * checkpoint envelopes so hydration tests can verify that a fresh process
 * (empty in-memory mirror) reconstructs full checkpoints from DBOS alone.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */
import type { DbosSdkHandle, DbosWorkflowInfo, DbosStepRecord } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

export interface MockDbosState {
  readonly workflows: Map<string, DbosWorkflowInfo>;
  /** stepName → envelope/output for each checkpoint workflow. */
  readonly steps: Map<string, WorkflowSerializableValue>;
  readonly starts: { workflowId: string; name: string }[];
  readonly cancels: string[];
  readonly resumes: string[];
  readonly deletions: string[];
}

export function createMockSdk(): DbosSdkHandle & { state: MockDbosState } {
  const state: MockDbosState = {
    workflows: new Map(),
    steps: new Map(),
    starts: [],
    cancels: [],
    resumes: [],
    deletions: [],
  };
  return {
    state,
    async launch() {},
    async shutdown() {},
    async startWorkflow(workflowId, name) {
      state.starts.push({ workflowId, name });
      // Simulate DBOS registering the workflow so it shows up in listAllWorkflows.
      if (!state.workflows.has(workflowId)) {
        state.workflows.set(workflowId, { workflowId, name, status: "PENDING", createdAt: Date.now() });
      }
    },
    async retrieveWorkflow(workflowId) { return state.workflows.get(workflowId); },
    async cancelWorkflow(workflowId) { state.cancels.push(workflowId); },
    async resumeWorkflow(workflowId) { state.resumes.push(workflowId); },
    async listAllWorkflows() { return [...state.workflows.values()]; },
    async listStepRecords(workflowId) {
      const prefix = `${workflowId}:checkpoint:`;
      const records: DbosStepRecord[] = [];
      for (const [key, output] of state.steps) {
        if (key.startsWith(prefix)) {
          records.push({ stepName: key.slice(prefix.length), output });
        }
      }
      return records;
    },
    async recordStepOutput(workflowId, stepName, output) {
      state.steps.set(`${workflowId}:checkpoint:${stepName}`, output);
    },
    async deleteWorkflowData(workflowId) { state.deletions.push(workflowId); state.workflows.delete(workflowId); for (const key of state.steps.keys()) if (key.startsWith(`${workflowId}:checkpoint:`)) state.steps.delete(key); },
  };
}

export function seedMockWorkflow(sdk: ReturnType<typeof createMockSdk>, info: Partial<DbosWorkflowInfo> & { workflowId: string }): void {
  sdk.state.workflows.set(info.workflowId, {
    workflowId: info.workflowId,
    name: info.name ?? "test-workflow",
    status: info.status ?? "PENDING",
    createdAt: info.createdAt ?? Date.now(),
    ...(info.inputs !== undefined ? { inputs: info.inputs } : {}),
  });
  const timestamp = info.createdAt ?? Date.now();
  const metadata = {
    workflowId: info.workflowId, name: info.name ?? "test-workflow", inputs: info.inputs ?? {},
    status: info.status === "SUCCESS" ? "completed" : info.status === "ERROR" ? "failed" : "running",
    completedCheckpoints: 0, pendingPrompts: 0, createdAt: timestamp,
    promptReservationEpoch: "seed-epoch", updatedAt: timestamp,
  };
  sdk.state.steps.set(
    `${info.workflowId}:checkpoint:__atomic_metadata:${timestamp}:seed`,
    { __atomicDurableMetadata: true, version: 3, metadata },
  );
}

export function seedMockCheckpoint(sdk: ReturnType<typeof createMockSdk>, workflowId: string, cp: DurableCheckpoint): void {
  const current = cp.kind === "stage" && cp.topology === undefined
    ? { ...cp, topology: { version: 1 as const, stageId: cp.checkpointId, parentIds: [] } }
    : cp;
  const envelope = encodeCheckpoint(current);
  sdk.state.steps.set(`${workflowId}:checkpoint:${cp.checkpointId}`, envelope);
}
