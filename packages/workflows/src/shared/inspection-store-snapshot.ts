import { createWorkflowGraphExpander, type ExpandedWorkflowGraph } from "./expanded-workflow-graph.js";
import type { Store } from "./store-public-types.js";
import type { RunSnapshot, StoreSnapshot } from "./store-types.js";
import { authoritativeWorkflowChildRunId, findSnapshotRun } from "./workflow-run-ownership.js";

export const prepareInspectionSnapshotKey = Symbol("workflow.prepare-inspection-snapshot");

export async function prepareInspectionStoreSnapshot(store: Store): Promise<void> {
	await (store as Store & { [prepareInspectionSnapshotKey]?: () => Promise<void> })[prepareInspectionSnapshotKey]?.();
}

interface ExpandedInspectionCache {
	readonly dependencies: ReadonlyMap<string, RunSnapshot | undefined>;
	readonly expanded: RunSnapshot;
}

const expandedRuns = new WeakMap<RunSnapshot, ExpandedInspectionCache>();
const inspectionExpanders = new WeakMap<StoreSnapshot, (runId: string) => ExpandedWorkflowGraph>();

function inspectionDependencies(snapshot: StoreSnapshot, root: RunSnapshot): Map<string, RunSnapshot | undefined> {
	const dependencies = new Map<string, RunSnapshot | undefined>([[root.id, root]]);
	const pending = [root];
	while (pending.length > 0) {
		const run = pending.pop()!;
		const ids = run.stages.map(authoritativeWorkflowChildRunId);
		if (run.parentRunId !== undefined) ids.push(run.parentRunId);
		for (const id of ids) {
			if (id === undefined || dependencies.has(id)) continue;
			const dependency = findSnapshotRun(snapshot.runs, id);
			dependencies.set(id, dependency);
			if (dependency !== undefined) pending.push(dependency);
		}
	}
	return dependencies;
}

function dependenciesUnchanged(snapshot: StoreSnapshot, cache: ExpandedInspectionCache): boolean {
	for (const [id, dependency] of cache.dependencies) {
		if (findSnapshotRun(snapshot.runs, id) !== dependency) return false;
	}
	return true;
}

export function readInspectionStoreSnapshot(store: Store, runId?: string): StoreSnapshot {
	return store.inspectionSnapshot?.(runId) ?? store.snapshot();
}

export function hasExpandedInspectionRun(snapshot: StoreSnapshot, runId: string): boolean {
	const run = findSnapshotRun(snapshot.runs, runId);
	if (run === undefined || !Object.isFrozen(run)) return false;
	const known = expandedRuns.get(run);
	return known !== undefined && dependenciesUnchanged(snapshot, known);
}

export function expandedInspectionRun(snapshot: StoreSnapshot, runId: string): RunSnapshot | undefined {
	const run = findSnapshotRun(snapshot.runs, runId);
	if (run === undefined) return undefined;
	const known = Object.isFrozen(run) ? expandedRuns.get(run) : undefined;
	if (known !== undefined && dependenciesUnchanged(snapshot, known)) return known.expanded;
	let expand = inspectionExpanders.get(snapshot);
	if (expand === undefined) {
		expand = createWorkflowGraphExpander(snapshot);
		if (Object.isFrozen(snapshot)) inspectionExpanders.set(snapshot, expand);
	}
	const graph = expand(runId);
	for (const stage of graph.stages) {
		Object.freeze(stage.workflowGraphTarget);
		Object.freeze(stage);
	}
	for (const tool of graph.tools) Object.freeze(tool);
	const expanded: RunSnapshot = { ...run, stages: [...graph.stages], toolNodes: [...graph.tools] };
	Object.freeze(expanded.stages);
	Object.freeze(expanded.toolNodes);
	Object.freeze(expanded);
	if (Object.isFrozen(run)) expandedRuns.set(run, { dependencies: inspectionDependencies(snapshot, run), expanded });
	return expanded;
}
