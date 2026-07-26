import { createToolPrimitive, type CreateToolPrimitiveInput } from "../durable/tool-primitive.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { WorkflowToolPrimitive } from "../shared/types.js";
import { unknownErrorMessage } from "../runs/foreground/executor-abort.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import { durableRunTopology } from "./run-durable-topology.js";
import { createAdmittedToolExecutionTracker, type AdmittedToolExecutionTracker } from "./run-tool-execution-tracker.js";
import type { RunTerminalEventArbiter } from "./run-terminal-event.js";

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

/** Wire durable tool execution to terminal-event arbitration and graph state. */
export function createTrackedToolPrimitive(input: {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextCheckpointId: () => string;
  readonly controller: AbortController;
  readonly terminalEvents: RunTerminalEventArbiter;
  readonly store: Store;
  readonly tracker: GraphFrontierTracker;
  readonly run: RunSnapshot;
  readonly sourceToReplayedNodeIds: Map<string, string>;
}): { readonly tool: WorkflowToolPrimitive; readonly admittedTools: AdmittedToolExecutionTracker } {
  const admittedTools = createAdmittedToolExecutionTracker({
    onFailureObserved: ({ error, nodeId }) => { input.terminalEvents.selectFailure(error, nodeId); },
    onFailureDuringDrain: (failure) => {
      if (input.terminalEvents.winner()?.kind === "failure") input.controller.abort(failure.error);
    },
  });
  const lifecycle = createToolNodeLifecycle(input);
  const tool = createToolPrimitive({
    workflowId: input.workflowId,
    backend: input.backend,
    onFailureObserved: admittedTools.observeFailure,
    nextCheckpointId: input.nextCheckpointId,
    throwIfCancelled: () => {
      if (input.controller.signal.aborted) throw new Error("atomic-workflows: workflow cancelled");
    },
    signal: input.controller.signal,
    trackExecution: admittedTools.track,
    ...lifecycle,
  });
  input.controller.signal.addEventListener("abort", () => {
    if (input.terminalEvents.winner()?.kind !== "failure") return;
    const endedAt = Date.now();
    const error = unknownErrorMessage(input.controller.signal.reason);
    for (const nodeId of admittedTools.abandonNonFailed()) {
      lifecycle.onNodeEnd?.(nodeId, { status: "cancelled", endedAt, error });
      lifecycle.onNodeSettle?.(nodeId);
    }
  }, { once: true });
  return { tool, admittedTools };
}
