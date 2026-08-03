import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { readGraphStoreSnapshot } from "../../shared/store-observation.js";
import type { Store } from "../../shared/store-public-types.js";
import { reciprocalWorkflowRootRunId } from "../../shared/workflow-run-ownership.js";

/** Control-run ids visible below one workflow boundary, in graph order. */
export function expandedControlRunIds(store: Store, runId: string): string[] {
	const graph = expandWorkflowGraph(readGraphStoreSnapshot(store), runId);
	const ids = new Set<string>([runId]);
	for (const stage of graph.stages) ids.add(stage.workflowGraphTarget.runId);
	// Tool-only nested runs own no stage, yet their in-flight ctx.tool nodes are
	// controllable work below this boundary.
	for (const tool of graph.tools) ids.add(tool.runId);
	return [...ids];
}

/** Find the aggregate top-level lifecycle owner for a nested child run. */
export function aggregateWorkflowRootRunId(store: Store, runId: string): string {
	const runById = new Map(store.runs().map((run) => [run.id, run]));
	return reciprocalWorkflowRootRunId(runById, runId) ?? runId;
}

/** Whether this workflow boundary contains a paused/blocked descendant stage. */
export function workflowHasPausedStages(store: Store, runId: string): boolean {
	return expandedControlRunIds(store, runId).some(
		(controlRunId) =>
			store
				.runs()
				.find((run) => run.id === controlRunId)
				?.stages.some((stage) => stage.status === "paused" || stage.status === "blocked") ?? false,
	);
}

/** Whether this workflow boundary or any descendant remains paused. */
export function workflowHasPausedState(store: Store, runId: string): boolean {
	return expandedControlRunIds(store, runId).some((controlRunId) => {
		const run = store.runs().find((candidate) => candidate.id === controlRunId);
		return (
			run?.status === "paused" ||
			run?.stages.some((stage) => stage.status === "paused" || stage.status === "blocked") === true
		);
	});
}
