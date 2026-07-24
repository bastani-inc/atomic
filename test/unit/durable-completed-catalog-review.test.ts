import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { durableHash, InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
  completedWorkflowRunSnapshots,
  completedWorkflowSnapshot,
  listCompletedFromBackend,
  listOpenableCompletedWorkflows,
  resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { RUN_TIMING_CHECKPOINT_NAME } from "../../packages/workflows/src/durable/run-timing.js";
import type { DurableCheckpoint, DurableStageRunTopology } from "../../packages/workflows/src/durable/types.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

function registerCompleted(backend: InMemoryDurableBackend, workflowId: string): void {
  backend.registerWorkflow({
    workflowId,
    name: workflowId,
    inputs: {},
    createdAt: 1,
    updatedAt: 100,
    status: "completed",
  });
}

function stage(
  workflowId: string,
  checkpointId: string,
  name: string,
  completedAt: number,
  extras: Partial<Extract<DurableCheckpoint, { kind: "stage" }>> = {},
): Extract<DurableCheckpoint, { kind: "stage" }> {
  return {
    kind: "stage",
    workflowId,
    checkpointId,
    name,
    replayKey: extras.replayKey ?? checkpointId,
    completedAt,
    ...extras,
  };
}

function tool(
  workflowId: string,
  checkpointId: string,
  name: string,
  argsHash: string,
  completedAt: number,
  extras: Partial<Extract<DurableCheckpoint, { kind: "tool" }>> = {},
): Extract<DurableCheckpoint, { kind: "tool" }> {
  return {
    kind: "tool",
    workflowId,
    checkpointId,
    name,
    argsHash,
    output: extras.output ?? name,
    completedAt,
    ...extras,
  };
}

function reconstructed(backend: InMemoryDurableBackend, workflowId: string): {
  runs: readonly RunSnapshot[];
  root: RunSnapshot;
  names: string[];
  orders: Array<number | undefined>;
} {
  const entry = listCompletedFromBackend(backend).find((item) => item.workflowId === workflowId)!;
  const runs = completedWorkflowRunSnapshots(backend, entry);
  const root = runs.find((run) => run.id === workflowId)!;
  const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, workflowId);
  return {
    runs,
    root,
    names: graph.nodes.map((node) => node.kind === "stage" ? node.stage.name : node.tool.name),
    orders: graph.nodes.map((node) => node.kind === "stage" ? node.stage.executionOrder : node.tool.executionOrder),
  };
}

describe("completed catalog reviewer regressions", () => {
  test("keeps a public workflow-run-timing tool visible while excluding the internal timing checkpoint", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "public-run-timing-name";
    registerCompleted(backend, workflowId);
    const argsHash = durableHash({ name: RUN_TIMING_CHECKPOINT_NAME, args: {}, ordinal: 1 });
    backend.recordCheckpoint(tool(workflowId, `tool:${argsHash}`, RUN_TIMING_CHECKPOINT_NAME, argsHash, 20));
    backend.recordCheckpoint(tool(
      workflowId,
      "run-timing:12345",
      RUN_TIMING_CHECKPOINT_NAME,
      RUN_TIMING_CHECKPOINT_NAME,
      30,
      { output: { elapsedMs: 12_345 } },
    ));

    assert.deepEqual(listOpenableCompletedWorkflows(backend).map((entry) => entry.workflowId), [workflowId]);
    const resolved = resolveCompletedWorkflow(workflowId, backend);
    assert.equal(resolved.kind, "found");
    if (resolved.kind !== "found") return;
    assert.equal(resolved.snapshot.durationMs, 12_345);
    assert.deepEqual(resolved.snapshot.toolNodes?.map((node) => ({
      name: node.name,
      status: node.status,
      topologyState: node.topologyState,
      attachable: node.attachable,
    })), [{
      name: RUN_TIMING_CHECKPOINT_NAME,
      status: "cached",
      topologyState: "unavailable",
      attachable: false,
    }]);
  });

  test("retains a scoped child tool whose public name matches the run-timing sentinel", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "scoped-name-root";
    const childRunId = "scoped-name-child";
    registerCompleted(backend, workflowId);
    const rootRun = { runId: workflowId, runName: workflowId } as const;
    const childRun: DurableStageRunTopology = {
      runId: childRunId,
      runName: "child",
      parentRunId: workflowId,
      parentStageId: "boundary",
      rootRunId: workflowId,
    };
    backend.recordCheckpoint(stage(workflowId, "boundary", "child-boundary", 10, {
      output: { workflow: "child", runId: childRunId, status: "completed", outputs: {} },
      topology: { version: 1, stageId: "boundary", parentIds: [], order: 1, run: rootRun },
    }));
    backend.recordCheckpoint(tool(workflowId, "child:tool:timing-name", RUN_TIMING_CHECKPOINT_NAME, "child:hpublic", 20, {
      topology: {
        version: 1,
        nodeId: "child-tool",
        ordinal: 1,
        order: 1,
        parentIds: [],
        run: childRun,
      },
    }));

    assert.equal(resolveCompletedWorkflow(workflowId, backend).kind, "found");
    const { runs } = reconstructed(backend, workflowId);
    const child = runs.find((run) => run.id === childRunId)!;
    assert.deepEqual(child.toolNodes?.map((node) => ({ name: node.name, attachable: node.attachable })), [{
      name: RUN_TIMING_CHECKPOINT_NAME,
      attachable: false,
    }]);
    const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, workflowId);
    assert.deepEqual(graph.tools.map((node) => node.name), [RUN_TIMING_CHECKPOINT_NAME]);
  });

  test("reconstructs legacy stage-tool-stage nodes in checkpoint sequence", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "legacy-mixed-sequence";
    registerCompleted(backend, workflowId);
    backend.recordCheckpoint(stage(workflowId, "before", "before", 10));
    backend.recordCheckpoint(tool(workflowId, "middle", "middle", "middle-hash", 20));
    backend.recordCheckpoint(stage(workflowId, "after", "after", 30));

    const result = reconstructed(backend, workflowId);
    assert.deepEqual(result.names, ["before", "middle", "after"]);
    assert.deepEqual(result.orders, [1, 2, 3]);
  });

  test("uses first logical checkpoint position across equal timestamps and repeated records", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "legacy-equal-time";
    registerCompleted(backend, workflowId);
    backend.recordCheckpoint(stage(workflowId, "before-session", "before", 10, {
      replayKey: "before",
      result: "early-stage",
    }));
    backend.recordCheckpoint(tool(workflowId, "middle-early", "middle", "middle-hash", 10, { output: "early-tool" }));
    backend.recordCheckpoint(stage(workflowId, "before-output", "before", 10, {
      replayKey: "before",
      result: "later-stage",
      output: "later-stage-output",
    }));
    backend.recordCheckpoint(tool(workflowId, "middle-late", "middle", "middle-hash", 10, { output: "later-tool" }));
    backend.recordCheckpoint(stage(workflowId, "after", "after", 10));

    const result = reconstructed(backend, workflowId);
    assert.deepEqual(result.names, ["before", "middle", "after"]);
    assert.deepEqual(result.orders, [1, 2, 5]);
    assert.equal(result.root.stages.find((node) => node.name === "before")?.result, "later-stage");
    assert.equal(result.root.toolNodes?.find((node) => node.name === "middle")?.resultSummary, '"later-tool"');
  });

  test("preserves legacy mixed checkpoint sequence after DBOS hydration", async () => {
    const sdk = createMockSdk();
    const workflowId = "legacy-dbos-order";
    const checkpoints = [
      stage(workflowId, "before", "before", 10),
      tool(workflowId, "middle", "middle", "middle-hash", 10),
      stage(workflowId, "after", "after", 10),
    ] as const;
    const beforeRestart = new InMemoryDurableBackend();
    registerCompleted(beforeRestart, workflowId);
    for (const checkpoint of checkpoints) beforeRestart.recordCheckpoint(checkpoint);
    const expected = reconstructed(beforeRestart, workflowId);

    seedMockWorkflow(sdk, { workflowId, name: workflowId, status: "SUCCESS", createdAt: 1 });
    for (const checkpoint of checkpoints) seedMockCheckpoint(sdk, workflowId, checkpoint);
    const fresh = new DbosDurableBackend(sdk);
    await fresh.hydrateWorkflow(workflowId);
    const entry = fresh.listCompletedWorkflows().find((item) => item.workflowId === workflowId)!;
    const runs = completedWorkflowRunSnapshots(fresh, entry);
    const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, workflowId);
    const names = graph.nodes.map((node) => node.kind === "stage" ? node.stage.name : node.tool.name);
    const orders = graph.nodes.map((node) => node.kind === "stage" ? node.stage.executionOrder : node.tool.executionOrder);
    assert.deepEqual({ names, orders }, { names: expected.names, orders: expected.orders });
    assert.deepEqual({ names, orders }, { names: ["before", "middle", "after"], orders: [1, 2, 3] });
  });

  test("persisted topology order overrides contradictory checkpoint sequence", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "topology-over-sequence";
    registerCompleted(backend, workflowId);
    const run = { runId: workflowId, runName: workflowId } as const;
    backend.recordCheckpoint(stage(workflowId, "after", "after", 10, {
      output: "after",
      topology: { version: 1, stageId: "after", parentIds: ["middle"], order: 3, run },
    }));
    backend.recordCheckpoint(tool(workflowId, "middle", "middle", "middle-hash", 20, {
      topology: { version: 1, nodeId: "middle", ordinal: 1, order: 2, parentIds: ["before"], run },
    }));
    backend.recordCheckpoint(stage(workflowId, "before", "before", 30, {
      output: "before",
      topology: { version: 1, stageId: "before", parentIds: [], order: 1, run },
    }));

    const result = reconstructed(backend, workflowId);
    assert.deepEqual(result.names, ["before", "middle", "after"]);
    assert.deepEqual(result.orders, [1, 2, 3]);
  });

  test("preserves nested topology-aware order and boundary fan-in", () => {
    const backend = new InMemoryDurableBackend();
    const workflowId = "nested-topology-order";
    const childRunId = "nested-topology-child";
    registerCompleted(backend, workflowId);
    const rootRun = { runId: workflowId, runName: workflowId } as const;
    const childRun: DurableStageRunTopology = {
      runId: childRunId,
      runName: "child",
      parentRunId: workflowId,
      parentStageId: "boundary",
      rootRunId: workflowId,
    };
    const childOutput = { workflow: "child", runId: childRunId, status: "completed", outputs: {} } as const;
    for (const checkpoint of [
      stage(workflowId, "right", "right", 10, { output: "right", topology: { version: 1, stageId: "right", parentIds: [], order: 3, run: childRun } }),
      tool(workflowId, "child-tool", "child-tool", "child-hash", 11, { topology: { version: 1, nodeId: "child-tool", ordinal: 1, order: 2, parentIds: [], run: childRun } }),
      stage(workflowId, "left", "left", 12, { output: "left", topology: { version: 1, stageId: "left", parentIds: [], order: 1, run: childRun } }),
      stage(workflowId, "before", "before", 13, { output: "before", topology: { version: 1, stageId: "before", parentIds: [], order: 1, run: rootRun } }),
      stage(workflowId, "boundary", "child-boundary", 14, { output: childOutput, topology: { version: 1, stageId: "boundary", parentIds: ["before"], order: 2, run: rootRun } }),
      stage(workflowId, "after", "after", 15, { output: "after", topology: { version: 1, stageId: "after", parentIds: ["boundary"], order: 3, run: rootRun } }),
    ]) backend.recordCheckpoint(checkpoint);

    const { runs } = reconstructed(backend, workflowId);
    const graph = expandWorkflowGraph({ runs, notices: [], version: 1 }, workflowId);
    assert.deepEqual(graph.nodes.map((node) => node.kind === "stage" ? node.stage.name : node.tool.name), [
      "before", "left", "child-tool", "right", "after",
    ]);
    const before = graph.stages.find((node) => node.name === "before")!;
    const left = graph.stages.find((node) => node.name === "left")!;
    const right = graph.stages.find((node) => node.name === "right")!;
    const after = graph.stages.find((node) => node.name === "after")!;
    const childTool = graph.tools.find((node) => node.name === "child-tool")!;
    assert.deepEqual(left.parentIds, [before.id]);
    assert.deepEqual(childTool.parentIds, [before.id]);
    assert.deepEqual(right.parentIds, [before.id]);
    assert.deepEqual(new Set(after.parentIds), new Set([left.id, childTool.id, right.id]));
    assert.equal(completedWorkflowSnapshot(backend, listCompletedFromBackend(backend)[0]!)?.id, workflowId);
  });
});
