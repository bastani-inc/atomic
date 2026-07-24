import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { buildWorkflowStatusListing } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { topLevelExpandedSnapshots } from "../../packages/workflows/src/extension/workflow-targets.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { store } from "../../packages/workflows/src/shared/store.js";

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe("nested ctx.tool status projection", () => {
  test("no-target status includes a tool-only child with explicit ownership", () => {
    store.recordRunStart({
      id: "status-root", name: "root workflow", inputs: {}, status: "completed", startedAt: 1, endedAt: 5,
      stages: [{
        id: "child-boundary", name: "child-boundary", status: "completed", parentIds: [], toolEvents: [],
        workflowChild: { runId: "status-child", alias: "child", workflow: "child workflow", status: "completed", outputs: {} },
      }],
      toolNodes: [],
    });
    store.recordRunStart({
      id: "status-child", name: "child workflow", inputs: {}, status: "completed", startedAt: 2, endedAt: 4,
      parentRunId: "status-root", rootRunId: "status-root", parentStageId: "child-boundary", stages: [],
      toolNodes: [{
        kind: "tool", id: "tool:publish", name: "publish", argsHash: "hash", ordinal: 1,
        parentIds: [], status: "cached", replayed: true, executionOrder: 1, attachable: false,
      }],
    });

    const snapshots = topLevelExpandedSnapshots();
    const listing = buildWorkflowStatusListing(snapshots, "all", 10);
    const tool = listing.runs[0]?.tools?.[0];
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]?.stages, []);
    assert.deepEqual(snapshots[0]?.toolNodes?.map((node) => node.name), ["publish"]);
    assert.match(snapshots[0]?.toolNodes?.[0]?.id ?? "", /^status-child:tool:publish$/);
    assert.deepEqual(tool, {
      id: "status-child:tool:publish",
      name: "publish",
      status: "cached",
      ordinal: 1,
      executionOrder: 1,
      parentIds: [],
      startedAt: undefined,
      endedAt: undefined,
      replayed: true,
      resultSummary: undefined,
      error: undefined,
      attachable: false,
      runId: "status-child",
      runName: "child workflow",
      depth: 1,
    });
    assert.match(renderWorkflowToolContent({ action: "status", ...listing }, { action: "status" }), /tools: publish \(cached\)/);
  });

  test("mixed root and child tools keep expanded order and rewritten parents", () => {
    store.recordRunStart({
      id: "mixed-root", name: "mixed root", inputs: {}, status: "running", startedAt: 1,
      stages: [{
        id: "mixed-boundary", name: "child", status: "completed", executionOrder: 2,
        parentIds: ["tool:before"], toolEvents: [], workflowChild: { runId: "mixed-child", alias: "child", workflow: "mixed child", status: "completed", outputs: {} },
      }],
      toolNodes: [
        { kind: "tool", id: "tool:before", name: "before", argsHash: "before", ordinal: 1, parentIds: [], status: "completed", executionOrder: 1, attachable: false },
        { kind: "tool", id: "tool:after", name: "after", argsHash: "after", ordinal: 1, parentIds: ["mixed-boundary"], status: "running", executionOrder: 3, attachable: false },
      ],
    });
    store.recordRunStart({
      id: "mixed-child", name: "mixed child", inputs: {}, status: "completed", startedAt: 2, endedAt: 3,
      parentRunId: "mixed-root", rootRunId: "mixed-root", parentStageId: "mixed-boundary", stages: [],
      toolNodes: [{
        kind: "tool", id: "tool:inside", name: "inside", argsHash: "inside", ordinal: 1,
        parentIds: [], status: "failed", error: "inside failed", executionOrder: 1, attachable: false,
      }],
    });

    const graph = expandWorkflowGraph(store.snapshot(), "mixed-root");
    const [snapshot] = topLevelExpandedSnapshots();
    assert.deepEqual(snapshot?.toolNodes?.map((tool) => [tool.name, tool.id, tool.parentIds, tool.status]), [
      ["before", "tool:before", [], "completed"],
      ["inside", "mixed-child:tool:inside", ["tool:before"], "failed"],
      ["after", "tool:after", ["mixed-child:tool:inside"], "running"],
    ]);
    assert.deepEqual(snapshot?.toolNodes, graph.tools);
    assert.equal(new Set(snapshot?.toolNodes?.map((tool) => tool.id)).size, 3);
    assert.deepEqual(buildWorkflowStatusListing([snapshot!], "all", 10).runs[0]?.tools?.map((tool) => tool.name), [
      "before", "inside", "after",
    ]);
  });

  test("sibling child tools retain virtual identity and explicit ownership without chat targets", () => {
    store.recordRunStart({
      id: "sibling-root", name: "sibling root", inputs: {}, status: "running", startedAt: 1,
      stages: [
        { id: "left-boundary", name: "left", status: "completed", executionOrder: 1, parentIds: [], toolEvents: [], workflowChild: { runId: "left-child", alias: "left", workflow: "left workflow", status: "completed", outputs: {} } },
        { id: "right-boundary", name: "right", status: "completed", executionOrder: 2, parentIds: ["left-boundary"], toolEvents: [], workflowChild: { runId: "right-child", alias: "right", workflow: "right workflow", status: "completed", outputs: {} } },
      ],
      toolNodes: [],
    });
    for (const [id, name, boundary] of [
      ["left-child", "left workflow", "left-boundary"],
      ["right-child", "right workflow", "right-boundary"],
    ] as const) {
      store.recordRunStart({
        id, name, inputs: {}, status: "completed", startedAt: 2, endedAt: 3,
        parentRunId: "sibling-root", rootRunId: "sibling-root", parentStageId: boundary, stages: [],
        toolNodes: [{
          kind: "tool", id: "tool:same", name: "same", argsHash: `${id}-hash`, ordinal: 1,
          parentIds: [], status: "cached", replayed: true, executionOrder: 1, attachable: false,
        }],
      });
    }

    const graph = expandWorkflowGraph(store.snapshot(), "sibling-root");
    const listing = buildWorkflowStatusListing(topLevelExpandedSnapshots(), "all", 10);
    assert.deepEqual(listing.runs[0]?.tools?.map(({ id, runId, runName, depth, attachable }) => ({
      id, runId, runName, depth, attachable,
    })), [
      { id: "left-child:tool:same", runId: "left-child", runName: "left workflow", depth: 1, attachable: false },
      { id: "right-child:tool:same", runId: "right-child", runName: "right workflow", depth: 1, attachable: false },
    ]);
    assert.deepEqual([...graph.targets.keys()], []);
    assert.deepEqual(graph.tools[1]?.parentIds, ["left-child:tool:same"]);
  });
});
