import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import type { Store } from "../../shared/store-public-types.js";

/** Control-run ids visible below one workflow boundary, in graph order. */
export function expandedControlRunIds(store: Store, runId: string): string[] {
  const graph = expandWorkflowGraph(store.snapshot(), runId);
  const ids = new Set<string>([runId]);
  for (const stage of graph.stages) ids.add(stage.workflowGraphTarget.runId);
  return [...ids];
}

/** Find the aggregate top-level lifecycle owner for a nested child run. */
export function aggregateWorkflowRootRunId(store: Store, runId: string): string {
  let current = runId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = store.runs().find((run) => run.stages.some((stage) =>
      stage.workflowChildRun?.runId === current || stage.workflowChild?.runId === current
    ));
    if (parent === undefined) return current;
    current = parent.id;
  }
  return current;
}

/** Whether this workflow boundary contains a paused/blocked descendant stage. */
export function workflowHasPausedStages(store: Store, runId: string): boolean {
  return expandedControlRunIds(store, runId).some((controlRunId) =>
    store.runs().find((run) => run.id === controlRunId)?.stages.some(
      (stage) => stage.status === "paused" || stage.status === "blocked",
    ) ?? false
  );
}

/** Whether this workflow boundary or any descendant remains paused. */
export function workflowHasPausedState(store: Store, runId: string): boolean {
  return expandedControlRunIds(store, runId).some((controlRunId) => {
    const run = store.runs().find((candidate) => candidate.id === controlRunId);
    return run?.status === "paused" || run?.stages.some(
      (stage) => stage.status === "paused" || stage.status === "blocked",
    ) === true;
  });
}
