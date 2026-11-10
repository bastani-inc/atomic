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
export function reciprocalWorkflowRootRunId(runById: RunsById, runId: string): string | undefined {
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

/** Runs by id without a scan; a `Store` is one. */
export interface RunLookup {
	run(runId: string): RunSnapshot | undefined;
	runs(): readonly RunSnapshot[];
	childRuns?(parentRunId: string, parentStageId?: string): readonly RunSnapshot[];
	runPosition?(runId: string): number | undefined;
}

/** A list of runs, scanned as given, or a lookup that finds each run by id. */
export type RunSource = readonly RunSnapshot[] | RunLookup;

export type RunsById = Pick<ReadonlyMap<string, RunSnapshot>, "get">;

export function isRunLookup(source: RunSource): source is RunLookup {
	return "run" in source;
}

export function runsInSource(source: RunSource): readonly RunSnapshot[] {
	return isRunLookup(source) ? source.runs() : source;
}

/** The first run with this id: a lookup is asked, a list is scanned. */
export function findRunInSource(source: RunSource, runId: string): RunSnapshot | undefined {
	return isRunLookup(source) ? source.run(runId) : source.find((run) => run.id === runId);
}

/** Runs by id; a lookup answers each `get` itself, so nothing is built per call. */
export function runsByIdOf(source: RunSource): RunsById {
	return isRunLookup(source) ? { get: (runId) => source.run(runId) } : new Map(source.map((run) => [run.id, run]));
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

/**
 * The index of a frozen array, from the cache when it has one: Bun's `Object.isFrozen` checks every element of an
 * array, so asking it on each lookup made a lookup cost the whole array again (#4642).
 */
function frozenIndex<T extends { readonly id: string }>(
	items: readonly T[],
	cache: WeakMap<readonly T[], ReadonlyMap<string, T>>,
): ReadonlyMap<string, T> | undefined {
	return cache.get(items) ?? (Object.isFrozen(items) ? index(items, cache) : undefined);
}

export function findSnapshotRun(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
	const byId = frozenIndex(runs, runIndexes);
	return byId === undefined ? runs.find((run) => run.id === runId) : byId.get(runId);
}

export function findSnapshotStage(stages: readonly StageSnapshot[], stageId: string): StageSnapshot | undefined {
	const byId = frozenIndex(stages, stageIndexes);
	return byId === undefined ? stages.find((stage) => stage.id === stageId) : byId.get(stageId);
}

/** The runs hanging from a run, or from one of its stages: asked of a lookup, scanned for in a list. */
export function childRunsInSource(
	source: RunSource,
	parentRunId: string,
	parentStageId?: string,
): readonly RunSnapshot[] {
	if (isRunLookup(source) && source.childRuns !== undefined) return source.childRuns(parentRunId, parentStageId);
	return runsInSource(source).filter(
		(run) => run.parentRunId === parentRunId && (parentStageId === undefined || run.parentStageId === parentStageId),
	);
}

/**
 * The runs of one invocation, in the order the source lists them: the run `rootRunId` and every descendant whose
 * parent and boundary links are complete and reciprocal back to it. A lookup walks down from the root through its
 * children, so the cost follows the invocation, not the runs the source holds; a list is filtered as before.
 */
export function invocationRunsInSource(source: RunSource, rootRunId: string): readonly RunSnapshot[] {
	const byId = runsByIdOf(source);
	const inInvocation = (run: RunSnapshot): boolean => reciprocalWorkflowRootRunId(byId, run.id) === rootRunId;
	if (!isRunLookup(source) || source.childRuns === undefined || source.runPosition === undefined)
		return runsInSource(source).filter(inInvocation);
	const root = source.run(rootRunId);
	if (root === undefined) return [];
	const seen = new Set<string>([root.id]);
	const found: RunSnapshot[] = [root];
	for (let index = 0; index < found.length; index++)
		for (const child of source.childRuns(found[index]!.id))
			if (!seen.has(child.id)) {
				seen.add(child.id);
				found.push(child);
			}
	return found
		.filter(inInvocation)
		.sort((left, right) => source.runPosition!(left.id)! - source.runPosition!(right.id)!);
}
