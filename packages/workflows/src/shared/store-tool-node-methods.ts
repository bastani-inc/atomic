import type { Store } from "./store-public-types.js";
import type { RunSnapshot, ToolNodeSnapshot } from "./store-types.js";
import type { StoreContext } from "./store-internal.js";

type ToolNodeStoreMethods = Pick<Store, "recordToolNodeStart" | "recordToolNodeRunning" | "recordToolNodeEnd">;

export function nextExecutionOrder(run: RunSnapshot): number {
  const stageOrders = run.stages.map((stage) => stage.executionOrder ?? 0);
  const toolOrders = (run.toolNodes ?? []).map((node) => node.executionOrder ?? 0);
  return Math.max(0, ...stageOrders, ...toolOrders) + 1;
}

export function createToolNodeStoreMethods(context: StoreContext): ToolNodeStoreMethods {
  return {
    recordToolNodeStart(runId, node): boolean {
      const run = context.findRun(runId);
      if (run === undefined) return false;
      const mutableRun = run as RunSnapshot & { toolNodes: ToolNodeSnapshot[] };
      if (mutableRun.toolNodes === undefined) mutableRun.toolNodes = [];
      const nodes = mutableRun.toolNodes;
      if (nodes.some((candidate) => candidate.id === node.id)) return false;
      if (node.executionOrder === undefined) node.executionOrder = nextExecutionOrder(run);
      nodes.push(node);
      context.bumpAndNotify();
      return true;
    },
    recordToolNodeRunning(runId, nodeId, startedAt): boolean {
      const node = context.findRun(runId)?.toolNodes?.find((candidate) => candidate.id === nodeId);
      if (node === undefined || node.status !== "pending") return false;
      node.status = "running";
      node.startedAt = startedAt;
      context.bumpAndNotify();
      return true;
    },
    recordToolNodeEnd(runId, nodeId, update): boolean {
      const node = context.findRun(runId)?.toolNodes?.find((candidate) => candidate.id === nodeId);
      if (node === undefined || node.status === "completed" || node.status === "failed" || node.status === "cached" || node.status === "cancelled") return false;
      node.status = update.status;
      if (update.endedAt !== undefined) node.endedAt = update.endedAt;
      if (update.resultSummary !== undefined) node.resultSummary = update.resultSummary;
      if (update.error !== undefined) node.error = update.error;
      context.bumpAndNotify();
      return true;
    },
  };
}
