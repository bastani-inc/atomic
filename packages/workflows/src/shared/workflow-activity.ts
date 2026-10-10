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
import {
	createWorkflowGraphExpander,
	type ExpandedWorkflowGraph,
	type ExpandedWorkflowNode,
} from "./expanded-workflow-graph.js";
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

function projectRoot(
	rootRunId: string,
	runs: readonly RunSnapshot[],
	runById: ReadonlyMap<string, RunSnapshot>,
	ownership: WorkflowActivityOwnership,
): WorkflowRootActivity {
	let activeExecutionCount = 0;
	let humanWaits = 0;
	let manualWaits = 0;
	let settledFailure = false;
	let retrying = false;
	let runnable = false;
	let paused = false;
	let stoppingExecutionCount = 0;
	let independentContinuation = false;
	let childContinuation = false;
	for (const run of runs) {
		const runStopping = isStoppingRun(run, rootRunId, runById, ownership.stoppingRunIds);
		let runExecutionCount = (run.toolNodes ?? []).filter((tool) =>
			ownership.executingToolNodeIds.has(workflowActivityNodeKey(run.id, tool.id)),
		).length;
		const acceptsAttention =
			run.status === "running" || run.status === "pending" || run.status === "failed" || run.status === "blocked";
		if (acceptsAttention && run.pendingPrompt) humanWaits++;
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
		// A replayed (cached) tool settles like a completed one: its successors are runnable.
		const statuses = new Map(
			[...run.stages, ...(run.toolNodes ?? [])].map((node) => [
				node.id,
				node.status === "cached" ? "completed" : node.status,
			]),
		);
		const live = ownership.liveRunIds?.has(run.id) === true;
		for (const tool of run.toolNodes ?? []) {
			// A tool node is admitted pending, before its executor is recorded; the live run is still working.
			if (
				live &&
				run.status === "running" &&
				!runStopping &&
				tool.status === "pending" &&
				tool.parentIds.every((id) => statuses.get(id) === "completed")
			) {
				runnable = true;
				independentContinuation = true;
			}
		}
		for (const stage of run.stages) {
			if (run.status === "running" && stage.status === "paused") paused = true;
			if (stage.status === "awaiting_input" || stage.pendingPrompt) {
				if (acceptsAttention && stage.status !== "paused") humanWaits++;
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
				stage.parentIds.every((id) => statuses.get(id) === "completed")
			) {
				runnable = true;
				independentContinuation = true;
			}
		}
		// Author code can admit its successor only after the previous primitive
		// settles. Retain the live executor's continuation across that gap, but
		// never treat a parked node or historical running status as runnable work.
		// A failed tool settles too: author code may handle it, and when it does
		// not, the run ends failed without ever having been idle.
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
			run.stages.every(
				(stage) =>
					!stage.pendingPrompt &&
					(stage.status === "completed" || stage.status === "skipped" || childBoundary(stage)),
			) &&
			(run.toolNodes ?? []).every(
				(tool) => tool.status === "completed" || tool.status === "cached" || tool.status === "failed",
			)
		) {
			if (run.stages.some(childBoundary)) childContinuation = true;
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
	} else if (actionableBlockCount > 0) {
		state = "blocked";
		reason = humanWaits > 0 ? "awaiting_input" : "manual_intervention";
	}
	return {
		rootRunId,
		ownerSessionId: ownership.ownerSessionId,
		state,
		reason,
		activeExecutionCount,
		actionableBlockCount,
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

function projectGraphNode(node: ExpandedWorkflowNode): WorkflowGraphNode {
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
function projectGraph(graph: ExpandedWorkflowGraph, runs: readonly RunSnapshot[]): WorkflowRootGraph {
	const runPrompts = runs.flatMap((run) =>
		run.pendingPrompt === undefined ? [] : [{ ...projectPrompt(run.pendingPrompt), runId: run.id }],
	);
	return { nodes: graph.nodes.map(projectGraphNode), ...(runPrompts.length === 0 ? {} : { runPrompts }) };
}

/** Full root replacements in first-root-occurrence order; inputs and stored outcomes are unchanged. */
export function projectWorkflowActivity({ snapshot, ownership }: WorkflowActivityInput): WorkflowRootActivity[] {
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
		...projectRoot(id, runs, byId, ownership),
		graph: projectGraph(expand(id), runs),
	}));
}
