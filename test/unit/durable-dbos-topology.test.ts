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
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";

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

  test("round-trips additive tool topology and accepts current legacy tools without it", () => {
    const checkpoint: DurableToolCheckpoint = {
      kind: "tool", workflowId: "wf-tool-topology", checkpointId: "tool:hash", name: "publish",
      argsHash: "hash", output: { ok: true }, completedAt: 3_000,
      topology: {
        version: 1, nodeId: "tool:hash", ordinal: 1, order: 2, parentIds: ["plan"], startedAt: 2_000, endedAt: 3_000,
        run: { runId: "wf-tool-topology", runName: "topology-test" },
      },
    };
    const decoded = decodeToCheckpoint(checkpoint.workflowId, checkpoint.checkpointId, encodeCheckpoint(checkpoint));
    assert.ok(decoded?.kind === "tool");
    assert.deepEqual(decoded.topology, checkpoint.topology);

    const legacy = { ...checkpoint, topology: undefined };
    const decodedLegacy = decodeToCheckpoint(legacy.workflowId, legacy.checkpointId, encodeCheckpoint(legacy));
    assert.ok(decodedLegacy?.kind === "tool");
    assert.equal(decodedLegacy.topology, undefined);
  });

  test("rejects a marked current stage envelope with missing topology", () => {
    const checkpoint = stage("wf-missing-topology");
    const envelope = { ...encodeCheckpoint(checkpoint), topology: undefined };
    assert.equal(decodeToCheckpoint(checkpoint.workflowId, checkpoint.checkpointId, envelope as never), undefined);
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
