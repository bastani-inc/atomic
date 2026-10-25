import type { ExpandedWorkflowStage } from "./expanded-workflow-graph.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStatus, StageSnapshot, StageStatus } from "./store-types.js";
import { matchStagePathSegments } from "./workflow-stage-path-matching.js";
import { formatWorkflowStageTarget } from "./workflow-stage-target.js";

const ADDRESSABLE_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set([
	"pending",
	"running",
	"awaiting_input",
	"paused",
	"blocked",
]);

/**
 * Stage statuses Intercom can address. The route roster advertises such a stage as reachable,
 * and a direct send to one that has no session yet is queued for that stage.
 */
export function isAddressableStageStatus(status: StageStatus): boolean {
	return ADDRESSABLE_STAGE_STATUSES.has(status);
}

/** Actionable identity and pre-start delivery state for one materialized pending stage. */
export interface PendingWorkflowStageStatus {
	readonly stageId: string;
	readonly name: string;
	readonly lifecycle: "pending";
	readonly pendingStageDeliveryAvailable: boolean;
	/** Exact Intercom target, present only when pre-start delivery is available. */
	readonly target?: string;
}
type PendingWorkflowRun = {
	readonly id: string;
	readonly rootRunId?: string;
	readonly status: RunStatus | "crashed";
};
export type PendingWorkflowRunStatusResolver = (runId: string) => RunStatus | "crashed" | undefined;
/** Boundary identity of each ancestor hop for a run, root run first; `undefined` when the lineage is broken. */
export type WorkflowBoundarySegmentsResolver = (runId: string) => readonly string[] | undefined;

/**
 * Depth-faithful boundary segments for `runId` (D8 clarification): one segment per
 * ancestor hop below the root, each the boundary-stage name when it resolves to
 * this child, else that boundary's materialized child-run id. `[]` for the root
 * run; `undefined` when a parent or boundary link is missing from `runs`.
 */
export function workflowBoundarySegments(runs: readonly RunSnapshot[], runId: string): readonly string[] | undefined {
	return createWorkflowBoundarySegmentsResolver(runs)(runId);
}

/** Build once per roster publication; never retain this resolver across store invalidations. */
export function createWorkflowBoundarySegmentsResolver(runs: readonly RunSnapshot[]): WorkflowBoundarySegmentsResolver {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const stagesByRun = new Map<string, { byId: Map<string, StageSnapshot[]>; byName: Map<string, StageSnapshot[]> }>();
	const childrenByParent = new Map<string, Map<string, RunSnapshot[]>>();
	for (const run of runs) {
		const byId = new Map<string, StageSnapshot[]>();
		const byName = new Map<string, StageSnapshot[]>();
		for (const stage of run.stages) {
			const ids = byId.get(stage.id) ?? [];
			ids.push(stage);
			byId.set(stage.id, ids);
			const names = byName.get(stage.name) ?? [];
			names.push(stage);
			byName.set(stage.name, names);
		}
		stagesByRun.set(run.id, { byId, byName });
		if (run.parentRunId === undefined || run.parentStageId === undefined) continue;
		const byStage = childrenByParent.get(run.parentRunId) ?? new Map<string, RunSnapshot[]>();
		const children = byStage.get(run.parentStageId) ?? [];
		children.push(run);
		byStage.set(run.parentStageId, children);
		childrenByParent.set(run.parentRunId, byStage);
	}
	const cachedSegments = new Map<string, readonly string[] | undefined>();
	return (runId) => {
		if (cachedSegments.has(runId)) return cachedSegments.get(runId);
		const segments: string[] = [];
		let current = runById.get(runId);
		while (current !== undefined && current.parentRunId !== undefined) {
			const parent = runById.get(current.parentRunId);
			const stages = stagesByRun.get(current.parentRunId);
			const boundary =
				current.parentStageId === undefined ? undefined : stages?.byId.get(current.parentStageId)?.[0];
			if (parent === undefined || stages === undefined || boundary === undefined) {
				cachedSegments.set(runId, undefined);
				return undefined;
			}
			const boundaryName = boundary.name;
			// Preserve ID-before-name precedence and reject ambiguous boundary names.
			const matchingBoundaries = stages.byId.get(boundaryName) ?? stages.byName.get(boundaryName);
			const matchingBoundary = matchingBoundaries?.length === 1 ? matchingBoundaries[0] : undefined;
			const children =
				matchingBoundary === undefined ? undefined : childrenByParent.get(parent.id)?.get(matchingBoundary.id);
			segments.unshift(
				boundaryName.length > 0 &&
					!boundaryName.includes("/") &&
					!boundaryName.includes("*") &&
					children?.length === 1 &&
					children[0]?.id === current.id
					? boundaryName
					: current.id,
			);
			current = parent;
		}
		const result = current === undefined ? undefined : segments;
		cachedSegments.set(runId, result);
		return result;
	};
}

/** One ancestor hop of a run's invocation lineage, keeping both depth-faithful spellings. */
export interface WorkflowBoundaryHop {
	/** The boundary stage's name. */
	readonly name: string;
	/** The materialized child-run id that the boundary stage spawned. */
	readonly runId: string;
}

/**
 * Boundary hops for `runId` (root run first), keeping both the boundary-stage name and
 * the materialized child-run id per hop: the D8 clarification allows the depth-faithful
 * segment to be "the boundary-stage name (or its materialized run id at that same
 * depth)" (D5). `undefined` when the lineage is broken. `[]` for the root run.
 */
export function workflowBoundaryHops(
	runs: readonly RunSnapshot[],
	runId: string,
): readonly WorkflowBoundaryHop[] | undefined {
	return boundaryHopsFrom(new Map(runs.map((run) => [run.id, run])), runId);
}

/**
 * Build once per runs snapshot: the same hops as {@link workflowBoundaryHops} for every
 * run, sharing one run index and caching each run's result, so walking every run of a
 * large invocation is linear instead of rebuilding the index per run.
 */
export function createWorkflowBoundaryHopsResolver(
	runs: readonly RunSnapshot[],
): (runId: string) => readonly WorkflowBoundaryHop[] | undefined {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const cache = new Map<string, readonly WorkflowBoundaryHop[] | undefined>();
	return (runId) => {
		if (cache.has(runId)) return cache.get(runId);
		const hops = boundaryHopsFrom(runById, runId);
		cache.set(runId, hops);
		return hops;
	};
}

function boundaryHopsFrom(
	runById: ReadonlyMap<string, RunSnapshot>,
	runId: string,
): readonly WorkflowBoundaryHop[] | undefined {
	const hops: WorkflowBoundaryHop[] = [];
	let current = runById.get(runId);
	while (current !== undefined && current.parentRunId !== undefined) {
		const parent = runById.get(current.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === current?.parentStageId);
		if (parent === undefined || boundary === undefined) return undefined;
		hops.unshift({ name: boundary.name, runId: current.id });
		current = parent;
	}
	return current === undefined ? undefined : hops;
}

/**
 * Every depth-faithful segment list for one stage: each boundary hop spelled as its
 * boundary-stage name or its materialized child-run id, closed by each stage spelling
 * (id and name). Sticky matching (D5) runs the target's glob segments against these
 * variants so a target addressed through a materialized child run id is honored.
 */
export function workflowStagePathVariants(
	hops: readonly WorkflowBoundaryHop[],
	stageSegments: readonly string[],
): string[][] {
	let prefixes: string[][] = [[]];
	for (const hop of hops) {
		prefixes = prefixes.flatMap((prefix) => {
			const withName = [...prefix, hop.name];
			return hop.runId === hop.name ? [withName] : [withName, [...prefix, hop.runId]];
		});
	}
	return prefixes.flatMap((prefix) => stageSegments.map((stage) => [...prefix, stage]));
}

/** Whether a sticky target's glob segments match any depth-faithful variant of a stage. */
export function stageMatchesPathPattern(
	patternSegments: readonly string[],
	hops: readonly WorkflowBoundaryHop[],
	stageSegments: readonly string[],
): boolean {
	return workflowStagePathVariants(hops, stageSegments).some((candidate) =>
		matchStagePathSegments(patternSegments, candidate),
	);
}

/**
 * Sticky glob targets indexed by their first segment. Matching one stage computes its
 * depth-faithful variants once and only tries the patterns that can match a variant's
 * first segment (a literal first segment must equal it) plus patterns whose first
 * segment is a glob. Results equal filtering the patterns with
 * {@link stageMatchesPathPattern}, in pattern order.
 */
export interface StagePathPatternIndex {
	/** Indexes into the indexed patterns that match the stage, ascending. */
	matching(hops: readonly WorkflowBoundaryHop[], stageSegments: readonly string[]): number[];
}

export function createStagePathPatternIndex(patterns: readonly (readonly string[])[]): StagePathPatternIndex {
	const byFirstSegment = new Map<string, number[]>();
	const globFirst: number[] = [];
	patterns.forEach((pattern, index) => {
		const first = pattern[0];
		if (first === undefined || first.includes("*")) {
			globFirst.push(index);
			return;
		}
		const bucket = byFirstSegment.get(first);
		if (bucket === undefined) byFirstSegment.set(first, [index]);
		else bucket.push(index);
	});
	return {
		matching(hops, stageSegments) {
			if (patterns.length === 0) return [];
			const variants = workflowStagePathVariants(hops, stageSegments);
			const candidates = new Set<number>(globFirst);
			for (const variant of variants) {
				for (const index of byFirstSegment.get(variant[0]!) ?? []) candidates.add(index);
			}
			return [...candidates]
				.sort((left, right) => left - right)
				.filter((index) => variants.some((variant) => matchStagePathSegments(patterns[index]!, variant)));
		},
	};
}

function pendingStageTarget(
	runId: string,
	stage: StageSnapshot,
): Pick<ExpandedWorkflowStage["workflowGraphTarget"], "runId" | "stageId"> {
	return "workflowGraphTarget" in stage
		? (stage as ExpandedWorkflowStage).workflowGraphTarget
		: { runId, stageId: stage.id };
}

export function pendingWorkflowStageStatus(
	run: PendingWorkflowRun,
	stage: StageSnapshot,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
	resolveBoundarySegments?: WorkflowBoundarySegmentsResolver,
): PendingWorkflowStageStatus | undefined {
	if (stage.status !== "pending") return undefined;
	const identity = pendingStageTarget(run.id, stage);
	const rootRunId = run.rootRunId ?? run.id;
	const owningRunStatus = identity.runId === run.id ? run.status : resolveOwningRunStatus?.(identity.runId);
	const pendingStageDeliveryAvailable =
		owningRunStatus !== undefined &&
		owningRunStatus !== "crashed" &&
		!isTerminalRunStatus(owningRunStatus) &&
		stage.pendingStageDeliveryAvailable === true;
	return {
		stageId: identity.stageId,
		name: stage.name,
		lifecycle: "pending",
		pendingStageDeliveryAvailable,
		...(pendingStageDeliveryAvailable
			? {
					target: formatWorkflowStageTarget(
						rootRunId,
						...(identity.runId === rootRunId
							? []
							: (resolveBoundarySegments?.(identity.runId) ?? [identity.runId])),
						identity.stageId,
					),
				}
			: {}),
	};
}

export function pendingWorkflowStageStatuses(
	run: Pick<RunSnapshot, "id" | "status" | "stages">,
	resolveOwningRunStatus?: PendingWorkflowRunStatusResolver,
	resolveBoundarySegments?: WorkflowBoundarySegmentsResolver,
): PendingWorkflowStageStatus[] {
	return run.stages.flatMap((stage) => {
		const pending = pendingWorkflowStageStatus(run, stage, resolveOwningRunStatus, resolveBoundarySegments);
		return pending === undefined ? [] : [pending];
	});
}
