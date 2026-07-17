import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DbosDurableBackend,
  type DbosSdkHandle,
  type DbosStepRecord,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
  decodeToCheckpoint,
  encodeCheckpoint,
} from "../../packages/workflows/src/durable/dbos-envelope.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

function stage(workflowId: string): DurableStageCheckpoint {
  return {
    kind: "stage",
    workflowId,
    checkpointId: "stage:review:1",
    name: "review",
    replayKey: "stage:review:1",
    output: "done",
    completedAt: 3_000,
    topology: { version: 1, stageId: "review", parentIds: ["plan"] },
  };
}

describe("current DBOS stage topology", () => {
  test("round-trips the single supported topology schema", () => {
    const checkpoint = stage("wf-stage-topology");
    const envelope = encodeCheckpoint(checkpoint);
    const decoded = decodeToCheckpoint(checkpoint.workflowId, checkpoint.checkpointId, envelope);
    assert.ok(decoded?.kind === "stage");
    assert.deepEqual(decoded.topology, checkpoint.topology);
  });

  for (const topology of [
    { version: 2, stageId: "review", parentIds: ["plan"] },
    { version: 1, stageId: "review", parentIds: "plan" },
  ]) {
    test(`rejects non-current topology ${JSON.stringify(topology)}`, async () => {
      const workflowId = `wf-invalid-topology-${topology.version}-${typeof topology.parentIds}`;
      const checkpoint = stage(workflowId);
      const metadata = encodeMetadata({
        workflowId,
        name: "topology-test",
        inputs: {},
        status: "completed",
        completedCheckpoints: 1,
        pendingPrompts: 0,
        createdAt: 1,
        promptReservationEpoch: "epoch",
        updatedAt: 3_000,
      });
      const records: DbosStepRecord[] = [
        { stepName: "__atomic_metadata:3000:test", output: metadata },
        { stepName: checkpoint.checkpointId, output: { ...encodeCheckpoint(checkpoint), topology } },
      ];
      const sdk: DbosSdkHandle = {
        launch: async () => {}, shutdown: async () => {}, startWorkflow: async () => {},
        retrieveWorkflow: async () => ({ workflowId, name: "topology-test", status: "SUCCESS", createdAt: 1 }),
        cancelWorkflow: async () => {}, resumeWorkflow: async () => {},
        listAllWorkflows: async () => [], listStepRecords: async () => records,
        recordStepOutput: async () => {}, deleteWorkflowData: async () => {},
      };

      const backend = new DbosDurableBackend(sdk);
      await backend.hydrateWorkflow(workflowId);
      assert.equal(backend.getWorkflow(workflowId), undefined);
      assert.deepEqual(backend.listCheckpoints(workflowId), []);
      assert.equal(backend.isWorkflowLoadable(workflowId), false);
    });
  }
});
