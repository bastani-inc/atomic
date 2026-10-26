import type { RunSnapshot, StageSnapshot } from "./store-types.js";

/** Child run selected by a boundary's status-authoritative ownership metadata. */
export function authoritativeWorkflowChildRunId(stage: StageSnapshot | undefined): string | undefined {
	if (stage === undefined || stage.status === "failed" || stage.status === "skipped") {
		return undefined;
	}
	if (stage.status === "completed") {
		return stage.workflowChild?.runId ?? stage.workflowChildRun?.runId;
	}
	return stage.workflowChildRun?.runId;
}

/**
 * Resolve a run's top-level owner through complete reciprocal parent-boundary
 * links. Omitted root ids are compatible unknown metadata; present root ids
 * must agree with the reached top-level run.
 */
export function reciprocalWorkflowRootRunId(
	runById: ReadonlyMap<string, RunSnapshot>,
	runId: string,
): string | undefined {
	const visited = new Set<string>();
	const declaredRoots: string[] = [];
	let current = runById.get(runId);

	while (current !== undefined) {
		const currentId = current.id;
		if (visited.has(currentId)) return undefined;
		visited.add(currentId);
		if (current.rootRunId !== undefined) declaredRoots.push(current.rootRunId);

		const parentRunId = current.parentRunId;
		const parentStageId = current.parentStageId;
		if ((parentRunId === undefined) !== (parentStageId === undefined)) return undefined;
		if (parentRunId === undefined || parentStageId === undefined) {
			return declaredRoots.every((declared) => declared === currentId) ? currentId : undefined;
		}

		const parent = runById.get(parentRunId);
		const boundary = parent === undefined ? undefined : findSnapshotStage(parent.stages, parentStageId);
		if (parent === undefined || authoritativeWorkflowChildRunId(boundary) !== currentId) {
			return undefined;
		}
		current = parent;
	}

	return undefined;
}

/**
 * Id lookups into frozen store snapshots (#3996).
 *
 * A graph snapshot is deep-frozen per store version, so an index built from one of its arrays
 * stays valid for as long as the array lives. Views that look up a run or stage per rendered
 * node use these instead of scanning, which made each layout quadratic in the stage count.
 * A mutable array is scanned as before, since it may change after an index is built.
 */
const runIndexes = new WeakMap<readonly RunSnapshot[], ReadonlyMap<string, RunSnapshot>>();
const stageIndexes = new WeakMap<readonly StageSnapshot[], ReadonlyMap<string, StageSnapshot>>();

function index<T extends { readonly id: string }>(
	items: readonly T[],
	cache: WeakMap<readonly T[], ReadonlyMap<string, T>>,
): ReadonlyMap<string, T> {
	let byId = cache.get(items);
	if (byId === undefined) {
		const built = new Map<string, T>();
		// The first item with an id wins, as `find` would return it.
		for (const item of items) if (!built.has(item.id)) built.set(item.id, item);
		byId = built;
		cache.set(items, byId);
	}
	return byId;
}

export function findSnapshotRun(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
	return Object.isFrozen(runs) ? index(runs, runIndexes).get(runId) : runs.find((run) => run.id === runId);
}

export function findSnapshotStage(stages: readonly StageSnapshot[], stageId: string): StageSnapshot | undefined {
	return Object.isFrozen(stages)
		? index(stages, stageIndexes).get(stageId)
		: stages.find((stage) => stage.id === stageId);
}
