import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import type { Store } from "../../shared/store-public-types.js";
import type { StageSnapshot } from "../../shared/store-types.js";

/** Control-run ids visible below one workflow boundary, in graph order. */
export function expandedControlRunIds(store: Store, runId: string): string[] {
  const graph = expandWorkflowGraph(store.snapshot(), runId);
  const ids = new Set<string>([runId]);
  for (const stage of graph.stages) ids.add(stage.workflowGraphTarget.runId);
  return [...ids];
}

function authoritativeChildRunId(stage: StageSnapshot | undefined): string | undefined {
  if (stage === undefined || stage.status === "failed" || stage.status === "skipped") return undefined;
  if (stage.status === "completed") return stage.workflowChild?.runId ?? stage.workflowChildRun?.runId;
  return stage.workflowChildRun?.runId;
}

/** Find the aggregate top-level lifecycle owner for a nested child run. */
export function aggregateWorkflowRootRunId(store: Store, runId: string): string {
  const runs = store.runs();
  let current = runId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const child = runs.find((run) => run.id === current);
    if (child?.parentRunId === undefined || child.parentStageId === undefined) return current;
    const parent = runs.find((run) => run.id === child.parentRunId);
    const boundary = parent?.stages.find((stage) => stage.id === child.parentStageId);
    const expectedRootRunId = parent?.rootRunId ?? parent?.id;
    const hasValidRoot = child.rootRunId === undefined || child.rootRunId === expectedRootRunId;
    if (parent === undefined || authoritativeChildRunId(boundary) !== current || !hasValidRoot) return current;
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
