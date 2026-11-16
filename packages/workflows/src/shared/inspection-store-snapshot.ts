import { expandWorkflowGraph } from "./expanded-workflow-graph.js";
import type { Store } from "./store-public-types.js";
import type { RunSnapshot, StoreSnapshot } from "./store-types.js";
import { findSnapshotRun } from "./workflow-run-ownership.js";

const expandedRuns = new WeakMap<StoreSnapshot, Map<string, RunSnapshot>>();

export function readInspectionStoreSnapshot(store: Store, runId?: string): StoreSnapshot {
	return store.inspectionSnapshot?.(runId) ?? store.snapshot();
}

export function expandedInspectionRun(snapshot: StoreSnapshot, runId: string): RunSnapshot | undefined {
	let runs = expandedRuns.get(snapshot);
	const known = runs?.get(runId);
	if (known !== undefined) return known;
	const run = findSnapshotRun(snapshot.runs, runId);
	if (run === undefined) return undefined;
	const graph = expandWorkflowGraph(snapshot, runId);
	for (const stage of graph.stages) {
		Object.freeze(stage.workflowGraphTarget);
		Object.freeze(stage);
	}
	for (const tool of graph.tools) Object.freeze(tool);
	const expanded: RunSnapshot = { ...run, stages: [...graph.stages], toolNodes: [...graph.tools] };
	Object.freeze(expanded.stages);
	Object.freeze(expanded.toolNodes);
	Object.freeze(expanded);
	if (runs === undefined) {
		runs = new Map();
		expandedRuns.set(snapshot, runs);
	}
	runs.set(runId, expanded);
	return expanded;
}
