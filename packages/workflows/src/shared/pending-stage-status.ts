import type { ExpandedWorkflowStage } from "./expanded-workflow-graph.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "./store-types.js";
import { matchStagePathSegments } from "./workflow-stage-path-matching.js";
import { formatWorkflowStageTarget } from "./workflow-stage-target.js";

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
 * ancestor hop below the root, each the boundary-stage name when it is a valid single
 * segment, else that boundary's materialized child-run id. `[]` for the root run;
 * `undefined` when a parent or boundary link is missing from `runs`.
 */
export function workflowBoundarySegments(runs: readonly RunSnapshot[], runId: string): readonly string[] | undefined {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const segments: string[] = [];
	let current = runById.get(runId);
	while (current !== undefined && current.parentRunId !== undefined) {
		const parent = runById.get(current.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === current?.parentStageId);
		if (parent === undefined || boundary === undefined) return undefined;
		const boundaryName = boundary.name;
		segments.unshift(
			boundaryName.length > 0 && !boundaryName.includes("/") && !boundaryName.includes("*")
				? boundaryName
				: current.id,
		);
		current = parent;
	}
	return current === undefined ? undefined : segments;
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
	const runById = new Map(runs.map((run) => [run.id, run]));
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
