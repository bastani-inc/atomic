import type { CreateToolPrimitiveInput } from "../durable/tool-primitive.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import { durableRunTopology } from "./run-durable-topology.js";

type ToolNodeLifecycle = Pick<
  CreateToolPrimitiveInput,
  "onNodeStart" | "onNodeRunning" | "onNodeEnd" | "onNodeSettle" | "runTopology"
>;

export function createToolNodeLifecycle(input: {
  readonly store: Store;
  readonly tracker: GraphFrontierTracker;
  readonly run: RunSnapshot;
  readonly sourceToReplayedNodeIds: Map<string, string>;
}): ToolNodeLifecycle {
  const { store, tracker, run, sourceToReplayedNodeIds } = input;
  return {
    onNodeStart: (node) => {
      const inferredParents = tracker.onSpawn(node.id, node.name);
      const sourceParents = node.replayed === true && node.topologyState !== "unavailable"
        ? node.parentIds
        : undefined;
      const restored = sourceParents?.map((sourceId) => sourceToReplayedNodeIds.get(sourceId));
      const parentIds = restored !== undefined && restored.every((id): id is string => id !== undefined)
        ? restored
        : inferredParents;
      tracker.replaceParents(node.id, parentIds);
      (node as ToolNodeSnapshot & { parentIds: readonly string[] }).parentIds = Object.freeze([...parentIds]);
      sourceToReplayedNodeIds.set(node.id, node.id);
      store.recordToolNodeStart(run.id, node);
    },
    onNodeRunning: (nodeId, startedAt) => { store.recordToolNodeRunning(run.id, nodeId, startedAt); },
    onNodeEnd: (nodeId, update) => { store.recordToolNodeEnd(run.id, nodeId, update); },
    onNodeSettle: (nodeId) => { tracker.onSettle(nodeId); },
    runTopology: durableRunTopology(run),
  };
}
