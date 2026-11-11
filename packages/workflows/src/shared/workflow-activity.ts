/**
 * Pure root activity projection. Stage, tool and retry ownership uses
 * workflowActivityNodeKey(runId, nodeId), encoded as `${runId}:${nodeId}`;
 * stopping and acknowledgement ownership uses plain run ids.
 */

import type {
	WorkflowGraphNode,
	WorkflowGraphNodePrompt,
	WorkflowRootActivity,
	WorkflowRootGraph,
} from "@bastani/atomic";
import { createWorkflowGraphExpander, type ExpandedWorkflowNode } from "./expanded-workflow-graph.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot, StoreSnapshot } from "./store-types.js";

/**
 * Runtime execution ownership for one session. executingStageIds,
 * executingToolNodeIds and retryingStageIds contain run-qualified keys from
 * workflowActivityNodeKey; stoppingRunIds and acknowledgedFailureRunIds contain run ids.
 */
export interface WorkflowActivityOwnership {
	readonly ownerSessionId: string;
	/** Live executor ownership, absent for historical/recovered snapshots. */
	readonly liveRunIds?: ReadonlySet<string>;
	readonly executingStageIds: ReadonlySet<string>;
	readonly executingToolNodeIds: ReadonlySet<string>;
	readonly stoppingRunIds: ReadonlySet<string>;
	readonly retryingStageIds: ReadonlySet<string>;
	readonly acknowledgedFailureRunIds: ReadonlySet<string>;
}

export interface WorkflowActivityInput {
	readonly snapshot: StoreSnapshot;
	readonly ownership: WorkflowActivityOwnership;
}

/**
 * Build a node ownership key; callers must never use a bare run-local node id.
 * The first `:` delimits the runtime UUID run id; node ids may themselves contain `:`.
 */
export function workflowActivityNodeKey(runId: string, nodeId: string): string {
	return `${runId}:${nodeId}`;
}

function rootId(run: RunSnapshot, runs: ReadonlyMap<string, RunSnapshot>): string {
	if (run.rootRunId !== undefined) return run.rootRunId;
	if (run.parentRunId === undefined) return run.id;
	const parent = runs.get(run.parentRunId);
	return parent ? rootId(parent, runs) : run.parentRunId;
}

/** Check retained parent ids before the folded root fallback, including absent ancestor snapshots. */
function isStoppingRun(
	run: RunSnapshot,
	rootRunId: string,
	runs: ReadonlyMap<string, RunSnapshot>,
	stoppingRunIds: ReadonlySet<string>,
): boolean {
	let id: string | undefined = run.id;
	while (id !== undefined) {
		if (stoppingRunIds.has(id)) return true;
		id = runs.get(id)?.parentRunId;
	}
	return stoppingRunIds.has(rootRunId);
}

/** Node statuses after which the node has run its course, whether it succeeded, failed or was abandoned. */
const endedStatuses: ReadonlySet<string> = new Set(["completed", "cached", "failed", "cancelled"]);

/** Whether a stage has run its course and asks for nothing: it adds nothing to a root's activity but its ownership. */
function isQuietStage(stage: StageSnapshot): boolean {
	return (
		(stage.status === "completed" || stage.status === "failed" || stage.status === "skipped") &&
		stage.pendingPrompt === undefined
	);
}

/**
 * Where a run's stages stand, kept from one version of the run to the next: a long run's finished stages are quiet, so
 * a root's activity reads only the stages that are not and the ownership sets, rather than every stage (#4642).
 */
interface RunStageIndex {
	readonly stages: readonly StageSnapshot[];
	/** Position of each stage by id; a run whose stages share an id is projected stage by stage instead. */
	readonly positions: Map<string, number>;
	/** Positions of the stages that are not quiet. */
	readonly active: Set<number>;
}

function indexStages(stages: readonly StageSnapshot[]): RunStageIndex | undefined {
	const positions = new Map<string, number>();
	const active = new Set<number>();
	for (let position = 0; position < stages.length; position++) {
		const stage = stages[position]!;
		if (positions.has(stage.id)) return undefined;
		positions.set(stage.id, position);
		if (!isQuietStage(stage)) active.add(position);
	}
	return { stages, positions, active };
}

/**
 * The index of `stages` from the index of an earlier version of the same run, looking again only at the stages that
 * are not the same objects; graph snapshots share every stage a change did not touch. Built anew when a stage moved.
 */
function reindexStages(
	stages: readonly StageSnapshot[],
	previous: RunStageIndex | undefined,
): RunStageIndex | undefined {
	if (previous === undefined || stages.length < previous.stages.length) return indexStages(stages);
	if (stages === previous.stages) return previous;
	const { positions, active } = previous;
	for (let position = 0; position < previous.stages.length; position++) {
		const stage = stages[position]!;
		if (stage === previous.stages[position]) continue;
		if (stage.id !== previous.stages[position]!.id) return indexStages(stages);
		if (isQuietStage(stage)) active.delete(position);
		else active.add(position);
	}
	for (let position = previous.stages.length; position < stages.length; position++) {
		const stage = stages[position]!;
		if (positions.has(stage.id)) return indexStages(stages);
		positions.set(stage.id, position);
		if (!isQuietStage(stage)) active.add(position);
	}
	return { stages, positions, active };
}

/** The ids after `${runId}:` of the keys in `keys` that name a node of that run. */
function* ownedNodeIds(keys: ReadonlySet<string>, runId: string): Generator<string> {
	const prefix = workflowActivityNodeKey(runId, "");
	for (const key of keys) if (key.startsWith(prefix)) yield key.slice(prefix.length);
}

function projectRoot(
	rootRunId: string,
	runs: readonly RunSnapshot[],
	runById: ReadonlyMap<string, RunSnapshot>,
	ownership: WorkflowActivityOwnership,
	stageIndexOf: (run: RunSnapshot) => RunStageIndex | undefined = () => undefined,
): WorkflowRootActivity {
	let activeExecutionCount = 0;
	let waitingStages = 0;
	let humanWaits = 0;
	let manualWaits = 0;
	let runPromptKind: PendingPrompt["kind"] | undefined;
	let stagePromptKind: PendingPrompt["kind"] | undefined;
	let settledFailure = false;
	let retrying = false;
	let runnable = false;
	let paused = false;
	let stoppingExecutionCount = 0;
	let independentContinuation = false;
	let childContinuation = false;
	for (const run of runs) {
		const runStopping = isStoppingRun(run, rootRunId, runById, ownership.stoppingRunIds);
		let runExecutionCount = run.toolNodes.filter((tool) =>
			ownership.executingToolNodeIds.has(workflowActivityNodeKey(run.id, tool.id)),
		).length;
		const acceptsAttention =
			run.status === "running" || run.status === "pending" || run.status === "failed" || run.status === "blocked";
		if (acceptsAttention && run.pendingPrompt) {
			humanWaits++;
			if (runPromptKind === undefined || run.pendingPrompt.kind === "confirm")
				runPromptKind = run.pendingPrompt.kind;
		}
		if (run.status === "paused") paused = true;
		if (
			acceptsAttention &&
			(run.status === "failed" ||
				run.status === "blocked" ||
				run.blockedAt !== undefined ||
				run.failureDisposition === "active_blocked") &&
			!ownership.acknowledgedFailureRunIds.has(run.id)
		) {
			// A finished failure is an outcome to inspect, not an open user decision.
			// Budget stops still require approval even after their executor settles.
			if (run.endedAt !== undefined && run.budgetState?.systemOwnedStop !== true) settledFailure = true;
			else manualWaits++;
		}
		// A node that ended, successfully or not, no longer holds its successors back: a replayed (cached)
		// tool settles like a completed one, and author code may catch a failure and carry on.
		const index = stageIndexOf(run);
		const nodeStatus = (node: { readonly status: string }): string =>
			endedStatuses.has(node.status) ? "ended" : node.status;
		const statuses =
			index === undefined
				? new Map([...run.stages, ...run.toolNodes].map((node) => [node.id, nodeStatus(node)]))
				: new Map(run.toolNodes.map((node) => [node.id, nodeStatus(node)]));
		const statusOf = (id: string): string | undefined => {
			if (index === undefined || statuses.has(id)) return statuses.get(id);
			const position = index.positions.get(id);
			return position === undefined ? undefined : nodeStatus(index.stages[position]!);
		};
		const live = ownership.liveRunIds?.has(run.id) === true;
		for (const tool of run.toolNodes) {
			// A tool node is admitted pending, before its executor is recorded; the live run is still working.
			if (
				live &&
				run.status === "running" &&
				!runStopping &&
				tool.status === "pending" &&
				tool.parentIds.every((id) => statusOf(id) === "ended")
			) {
				runnable = true;
				independentContinuation = true;
			}
		}
		// A quiet stage counts only when an ownership set names it; the sets hold the few nodes executing now.
		const activeStages =
			index === undefined
				? run.stages
				: [...index.active].sort((left, right) => left - right).map((position) => index.stages[position]!);
		if (index !== undefined) {
			const quietOwned = (stageId: string): boolean => {
				const position = index.positions.get(stageId);
				return position !== undefined && !index.active.has(position);
			};
			for (const stageId of ownedNodeIds(ownership.executingStageIds, run.id))
				if (quietOwned(stageId)) runExecutionCount++;
			for (const stageId of ownedNodeIds(ownership.retryingStageIds, run.id)) {
				if (!quietOwned(stageId)) continue;
				retrying = true;
				if (!runStopping) independentContinuation = true;
			}
		}
		for (const stage of activeStages) {
			if (run.status === "running" && stage.status === "paused") paused = true;
			// A waiting stage of a live run holds no session but resumes on its own when what it waits on arrives.
			if (live && run.status === "running" && !runStopping && stage.status === "suspended") waitingStages++;
			if (stage.status === "awaiting_input" || stage.pendingPrompt) {
				if (acceptsAttention && stage.status !== "paused") {
					humanWaits++;
					if (stagePromptKind === undefined || stage.pendingPrompt?.kind === "confirm")
						stagePromptKind = stage.pendingPrompt?.kind;
				}
				continue;
			}
			const key = workflowActivityNodeKey(run.id, stage.id);
			if (ownership.executingStageIds.has(key)) runExecutionCount++;
			if (ownership.retryingStageIds.has(key)) {
				retrying = true;
				if (!runStopping) independentContinuation = true;
			}
			if (
				run.status === "running" &&
				!runStopping &&
				stage.status === "pending" &&
				stage.parentIds.every((id) => statusOf(id) === "ended")
			) {
				runnable = true;
				independentContinuation = true;
			}
		}
		// Author code can admit its successor only after the previous primitive
		// settles. Retain the live executor's continuation across that gap, but
		// never treat a parked node or historical running status as runnable work.
		// A failed (or, once the run is failing, cancelled) node settles too: author code may handle
		// the failure, and when it does not, the run ends failed without ever having been idle.
		// A nested workflow's boundary stage is owned by the child run, which has
		// its own gaps (before it goes live, and after it ends before the parent
		// stage settles), so the parent continues unless something waits or pauses.
		const childBoundary = (stage: StageSnapshot) =>
			stage.status === "running" && stage.workflowChildRun !== undefined;
		if (
			live &&
			run.status === "running" &&
			!runStopping &&
			!run.pendingPrompt &&
			run.blockedAt === undefined &&
			run.failureDisposition !== "active_blocked" &&
			activeStages.every(
				(stage) =>
					!stage.pendingPrompt &&
					(stage.status === "completed" ||
						stage.status === "failed" ||
						stage.status === "skipped" ||
						childBoundary(stage)),
			) &&
			run.toolNodes.every((tool) => endedStatuses.has(tool.status))
		) {
			if (activeStages.some(childBoundary)) childContinuation = true;
			else {
				runnable = true;
				independentContinuation = true;
			}
		}
		activeExecutionCount += runExecutionCount;
		if (runStopping) stoppingExecutionCount += runExecutionCount;
	}
	const actionableBlockCount = humanWaits + manualWaits;
	if (childContinuation && actionableBlockCount === 0 && !paused) {
		runnable = true;
		independentContinuation = true;
	}
	let state: WorkflowRootActivity["state"] = "idle";
	let reason: WorkflowRootActivity["reason"] = paused ? "paused" : "quiescent";
	if (activeExecutionCount > 0 || retrying || runnable) {
		state = "working";
		reason =
			activeExecutionCount > 0 && stoppingExecutionCount === activeExecutionCount && !independentContinuation
				? "stopping"
				: retrying
					? "retrying"
					: activeExecutionCount > 0
						? "executing"
						: "automatic_continuation";
	} else if (waitingStages > 0) {
		state = "working";
		reason = "waiting";
	} else if (actionableBlockCount > 0) {
		state = "blocked";
		reason = humanWaits > 0 ? "awaiting_input" : "manual_intervention";
	}
	const blockedPromptKind = runPromptKind ?? stagePromptKind;
	const rootStatus = runById.get(rootRunId)?.status;
	const endedStatus =
		rootStatus === "completed" || rootStatus === "cancelled" || rootStatus === "killed" || rootStatus === "failed"
			? rootStatus
			: undefined;
	return {
		rootRunId,
		ownerSessionId: ownership.ownerSessionId,
		state,
		reason,
		activeExecutionCount,
		actionableBlockCount,
		...(blockedPromptKind === undefined ? {} : { blockedPromptKind }),
		...(endedStatus === undefined ? {} : { endedStatus }),
		needsAttention: actionableBlockCount > 0 || settledFailure,
	};
}

function projectPrompt(prompt: PendingPrompt): WorkflowGraphNodePrompt {
	return {
		id: prompt.id,
		kind: prompt.kind,
		message: prompt.message,
		...(prompt.choices === undefined ? {} : { choices: [...prompt.choices] }),
		createdAt: prompt.createdAt,
	};
}

/** Freezes a projected graph node and the arrays and prompt in it, so the activity hub can share it (#4642). */
function frozenGraphNode(node: WorkflowGraphNode): WorkflowGraphNode {
	Object.freeze(node.parentIds);
	if (node.kind === "stage" && node.pendingPrompt !== undefined) {
		if (node.pendingPrompt.choices !== undefined) Object.freeze(node.pendingPrompt.choices);
		Object.freeze(node.pendingPrompt);
	}
	return Object.freeze(node);
}

/**
 * Projections of expanded nodes. Expansion reuses the node objects of unchanged child runs
 * (#4009), so a root's graph re-projects only the nodes that changed; a node is never mutated
 * after expansion, so its projection stays valid for as long as it lives.
 */
const projectedGraphNodes = new WeakMap<ExpandedWorkflowNode, WorkflowGraphNode>();

function projectGraphNode(node: ExpandedWorkflowNode): WorkflowGraphNode {
	let projected = projectedGraphNodes.get(node);
	if (projected === undefined) {
		projected = frozenGraphNode(projectExpandedNode(node));
		projectedGraphNodes.set(node, projected);
	}
	return projected;
}

/** The expanded nodes of a root's graph and their projections, kept to project the root's next graph from them. */
interface ProjectedNodes {
	readonly expanded: readonly ExpandedWorkflowNode[];
	readonly projected: readonly WorkflowGraphNode[];
}

/**
 * The projections of `expanded`, reusing those of `previous` for every node that is the same object at the same
 * position: expansion reuses the node objects of unchanged stages, so only the nodes that changed are looked up.
 */
function projectNodes(
	expanded: readonly ExpandedWorkflowNode[],
	previous: ProjectedNodes | undefined,
): WorkflowGraphNode[] {
	if (previous === undefined) return expanded.map(projectGraphNode);
	const projected = previous.projected.slice(0, expanded.length);
	for (let index = 0; index < expanded.length; index++) {
		const node = expanded[index]!;
		if (index >= projected.length) projected.push(projectGraphNode(node));
		else if (node !== previous.expanded[index]) projected[index] = projectGraphNode(node);
	}
	return projected;
}

function projectExpandedNode(node: ExpandedWorkflowNode): WorkflowGraphNode {
	if (node.kind === "stage") {
		const { stage } = node;
		const target = stage.workflowGraphTarget;
		return {
			kind: "stage",
			id: stage.id,
			runId: target.runId,
			nodeId: target.stageId,
			name: stage.name,
			status: stage.status,
			parentIds: [...stage.parentIds],
			...(stage.executionOrder === undefined ? {} : { executionOrder: stage.executionOrder }),
			depth: target.depth,
			...(stage.pendingPrompt === undefined ? {} : { pendingPrompt: projectPrompt(stage.pendingPrompt) }),
		};
	}
	const { tool } = node;
	return {
		kind: "tool",
		id: tool.id,
		runId: tool.runId,
		// Only the root run (depth 0) keeps run-local ids in the expanded graph.
		nodeId: tool.depth === 0 ? tool.id : tool.id.slice(tool.runId.length + 1),
		name: tool.name,
		status: tool.status,
		parentIds: [...tool.parentIds],
		...(tool.executionOrder === undefined ? {} : { executionOrder: tool.executionOrder }),
		depth: tool.depth,
		ordinal: tool.ordinal,
	};
}

/** JSON-serializable expanded graph of one root, including nested child workflow runs. */
function projectGraph(nodes: WorkflowGraphNode[], runs: readonly RunSnapshot[]): WorkflowRootGraph {
	const runPrompts = runs.flatMap((run) =>
		run.pendingPrompt === undefined ? [] : [{ ...projectPrompt(run.pendingPrompt), runId: run.id }],
	);
	return { nodes, ...(runPrompts.length === 0 ? {} : { runPrompts }) };
}

function projectActivities(
	{ snapshot, ownership }: WorkflowActivityInput,
	stageIndexOf: (run: RunSnapshot) => RunStageIndex | undefined,
	projectRootNodes: (rootRunId: string, expanded: readonly ExpandedWorkflowNode[]) => WorkflowGraphNode[],
): WorkflowRootActivity[] {
	const byId = new Map(snapshot.runs.map((run) => [run.id, run]));
	const roots = new Map<string, RunSnapshot[]>();
	for (const run of snapshot.runs) {
		const id = rootId(run, byId);
		const group = roots.get(id);
		if (group) group.push(run);
		else roots.set(id, [run]);
	}
	const expand = createWorkflowGraphExpander(snapshot);
	return [...roots].map(([id, runs]) => ({
		...projectRoot(id, runs, byId, ownership, stageIndexOf),
		graph: projectGraph(projectRootNodes(id, expand(id).nodes), runs),
	}));
}

/**
 * Projects root activity version after version of one store, reusing what it read of the previous version: the stage
 * index of each run and the node projections of each root, so a change costs the stages it touched rather than every
 * stage a run finished (#4642). Its output equals `projectWorkflowActivity` over the same input.
 */
export class WorkflowActivityProjector {
	private stageIndexes = new Map<string, RunStageIndex>();
	private projectedNodes = new Map<string, ProjectedNodes>();

	project(input: WorkflowActivityInput): WorkflowRootActivity[] {
		const previousIndexes = this.stageIndexes;
		const previousNodes = this.projectedNodes;
		const stageIndexes = new Map<string, RunStageIndex>();
		const projectedNodes = new Map<string, ProjectedNodes>();
		const activities = projectActivities(
			input,
			(run) => {
				const index = reindexStages(run.stages, previousIndexes.get(run.id));
				if (index !== undefined) stageIndexes.set(run.id, index);
				return index;
			},
			(rootRunId, expanded) => {
				const projected = projectNodes(expanded, previousNodes.get(rootRunId));
				projectedNodes.set(rootRunId, { expanded, projected });
				return projected;
			},
		);
		this.stageIndexes = stageIndexes;
		this.projectedNodes = projectedNodes;
		return activities;
	}
}

/** Full root replacements in first-root-occurrence order; inputs and stored outcomes are unchanged. */
export function projectWorkflowActivity(input: WorkflowActivityInput): WorkflowRootActivity[] {
	return projectActivities(
		input,
		() => undefined,
		(_rootRunId, expanded) => expanded.map(projectGraphNode),
	);
}
