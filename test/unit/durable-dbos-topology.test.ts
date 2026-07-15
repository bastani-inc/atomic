import { test } from "bun:test";
import assert from "node:assert/strict";
import { DbosDurableBackend, type DbosSdkHandle } from "../../packages/workflows/src/durable/dbos-backend.js";
import { decodeToCheckpoint, encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

test("DBOS stage envelopes round-trip versioned topology metadata", () => {
  const topology = { version: 1, stageId: "source-review", parentIds: ["source-plan"] } as const;
  const checkpoint: DurableStageCheckpoint = {
    kind: "stage",
    workflowId: "wf-stage-topology",
    checkpointId: "stage:review:1",
    name: "review",
    replayKey: "stage:review:1",
    output: "done",
    completedAt: 3000,
    topology,
  };

  const envelope = encodeCheckpoint(checkpoint);
  assert.deepEqual(envelope.topology, topology);
  const decoded = decodeToCheckpoint(checkpoint.workflowId, checkpoint.checkpointId, envelope);
  assert.ok(decoded?.kind === "stage");
  assert.deepEqual(decoded.topology, topology);
});

for (const fixture of [
  { label: "unsupported", topology: { version: 2, stageId: "future-review", parentIds: ["future-plan"] } },
  { label: "malformed", topology: { version: 1, stageId: "broken-review", parentIds: "not-an-array" } },
] as const) {
  test(`DBOS hydration preserves stage checkpoints when topology is ${fixture.label}`, async () => {
    const workflowId = `wf-${fixture.label}-topology`;
    const checkpoint: DurableStageCheckpoint = {
      kind: "stage",
      workflowId,
      checkpointId: "stage:review:1",
      name: "review",
      replayKey: "stage:review:1",
      output: "preserved output",
      completedAt: 3000,
    };
    const envelope = { ...encodeCheckpoint(checkpoint), topology: fixture.topology };
    const records = [
      {
        stepName: "__atomic_metadata:3000:test",
        output: encodeMetadata({
          formatVersion: 2,
          type: "workflow.durable.checkpoint",
          workflowId,
          name: "topology-test",
          inputs: {},
          status: "completed",
          completedCheckpoints: 1,
          pendingPrompts: 0,
          ts: 3000,
        }),
      },
      { stepName: checkpoint.checkpointId, output: envelope },
    ];
    const sdk: DbosSdkHandle = {
      async launch() {},
      async shutdown() {},
      async startWorkflow() {},
      async retrieveWorkflow() { return { workflowId, name: "topology-test", status: "SUCCESS", createdAt: 1 }; },
      async cancelWorkflow() {},
      async resumeWorkflow() {},
      async listAllWorkflows() { return []; },
      async listStepRecords() { return records; },
      async recordStepOutput() {},
      async deleteWorkflowData() {},
    };

    const hydrated = new DbosDurableBackend(sdk);
    await hydrated.hydrateWorkflow(workflowId);
    const decoded = hydrated.listCheckpoints(workflowId)[0];

    assert.ok(decoded?.kind === "stage");
    assert.equal(decoded.output, "preserved output");
    assert.equal(decoded.topology, undefined);
  });
}
