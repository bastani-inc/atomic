import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { CheckpointCatalogIndex } from "./completed-catalog-index.js";
import {
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageRunTopology,
	type DurableToolCheckpoint,
} from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";

export interface StageDraft {
	readonly replayKey: string;
	readonly name: string;
	readonly firstCompletedAt: number;
	readonly firstSequence: number;
	readonly sourceIds: readonly string[];
	readonly output?: DurableStageCheckpoint["output"];
	readonly result?: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly attemptedModels?: readonly string[];
	readonly modelAttempts?: DurableStageCheckpoint["modelAttempts"];
	readonly rateLimits?: DurableStageCheckpoint["rateLimits"];
	readonly routerSelection?: DurableStageCheckpoint["routerSelection"];
	readonly topology?: DurableStageCheckpoint["topology"];
}

export function validBoundaryRecordSet(index: CheckpointCatalogIndex, strict: boolean): boolean {
	const boundaries = index.stages.filter((item) => item.topology?.boundary !== undefined);
	const startsByReplay = new Map<string, DurableStageCheckpoint[]>();
	for (const checkpoint of boundaries) {
		if (checkpoint.topology!.boundary!.event !== "start") continue;
		const starts = startsByReplay.get(checkpoint.replayKey) ?? [];
		starts.push(checkpoint);
		startsByReplay.set(checkpoint.replayKey, starts);
	}
	if ([...startsByReplay.values()].some((starts) => starts.length !== 1)) return false;
	if (
		boundaries.some(
			(checkpoint) =>
				checkpoint.topology!.boundary!.event === "terminal" &&
				startsByReplay.get(checkpoint.replayKey)?.length !== 1,
		)
	)
		return false;
	return [...startsByReplay.values()].every((starts) => {
		const start = starts[0]!;
		if ("error" in index.boundaryLifecycle(start, strict)) return false;
		return start.topology!.boundary!.invocationFingerprint !== undefined;
	});
}

export function validStageGroup(
	drafts: readonly StageDraft[],
	runId: string,
	rootRunId: string,
	tools: readonly DurableToolCheckpoint[] = [],
): boolean {
	if (drafts.some((draft) => draft.topology!.stageId.length === 0)) return false;
	if (
		tools.some(
			(tool) =>
				tool.topology !== undefined &&
				(tool.topology.version !== DURABLE_TOOL_TOPOLOGY_VERSION || tool.topology.nodeId.length === 0),
		)
	)
		return false;
	const stageIds = drafts.map((draft) => draft.topology!.stageId);
	const toolIds = tools.map((tool) => tool.topology?.nodeId ?? tool.checkpointId);
	const ids = new Set([...stageIds, ...toolIds]);
	if (ids.size !== stageIds.length + toolIds.length) return false;
	const orders = drafts.flatMap((draft) =>
		draft.topology!.sourceOrder === undefined ? [] : [draft.topology!.sourceOrder],
	);
	if (new Set(orders).size !== orders.length) return false;
	const parentEntries: ReadonlyArray<readonly [string, readonly string[]]> = [
		...drafts.map((draft) => [draft.topology!.stageId, draft.topology!.parentIds] as const),
		...tools.map((tool) => [tool.topology?.nodeId ?? tool.checkpointId, tool.topology?.parentIds ?? []] as const),
	];
	if (parentEntries.some(([, parentIds]) => parentIds.some((parentId) => !ids.has(parentId)))) return false;
	const runs = [
		...drafts.flatMap((draft) => (draft.topology?.run === undefined ? [] : [draft.topology.run])),
		...tools.flatMap((tool) => (tool.topology?.run === undefined ? [] : [tool.topology.run])),
	];
	const first = runs[0];
	if (
		runs.some(
			(run) =>
				run.runId !== runId ||
				(first !== undefined &&
					(run.runName !== first.runName ||
						run.parentRunId !== first.parentRunId ||
						run.parentStageId !== first.parentStageId ||
						run.rootRunId !== first.rootRunId)),
		)
	)
		return false;
	if (
		runId === rootRunId &&
		runs.some(
			(run) => run.parentRunId !== undefined || run.parentStageId !== undefined || run.rootRunId !== undefined,
		)
	)
		return false;
	const parents = new Map(parentEntries);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const cyclic = (nodeId: string): boolean => {
		if (visiting.has(nodeId)) return true;
		if (visited.has(nodeId)) return false;
		visiting.add(nodeId);
		if ((parents.get(nodeId) ?? []).some(cyclic)) return true;
		visiting.delete(nodeId);
		visited.add(nodeId);
		return false;
	};
	return ![...ids].some(cyclic);
}

export function compareDraftSourceOrder(left: StageDraft, right: StageDraft): number {
	const leftOrder = left.topology?.sourceOrder;
	const rightOrder = right.topology?.sourceOrder;
	if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
	if (leftOrder !== undefined) return -1;
	if (rightOrder !== undefined) return 1;
	return left.firstCompletedAt - right.firstCompletedAt;
}

export function runTopologyFor(
	drafts: readonly StageDraft[],
	tools: readonly DurableToolCheckpoint[],
): DurableStageRunTopology | undefined {
	return (
		drafts.find((draft) => draft.topology?.run !== undefined)?.topology?.run ??
		tools.find((checkpoint) => checkpoint.topology?.run !== undefined)?.topology?.run
	);
}

export function validateRunGroups(
	grouped: Map<string, StageDraft[]>,
	rootRunId: string,
	toolsByRun: ReadonlyMap<string, readonly DurableToolCheckpoint[]>,
	index: CheckpointCatalogIndex,
	allowPendingChildren = false,
): boolean {
	const toolsFor = (runId: string) => toolsByRun.get(runId) ?? [];
	const owners = new Map<string, StageDraft>();
	const syntheticChildIds = new Set<string>();
	for (const [parentRunId, drafts] of grouped) {
		for (const draft of drafts) {
			const childRunId = childRunIdFromDraft(draft);
			if (childRunId === undefined) continue;
			if (childRunId === parentRunId || owners.has(childRunId)) return false;
			if (!grouped.has(childRunId)) {
				if (
					allowPendingChildren &&
					isPendingChildBoundary(draft, parentRunId, childRunId, rootRunId) &&
					!index.childScopedEvidenceExists(draft.replayKey, childRunId)
				) {
					syntheticChildIds.add(childRunId);
					owners.set(childRunId, draft);
					continue;
				}
				if (
					!isSyntheticExitedChild(draft, parentRunId, childRunId, rootRunId) ||
					index.childScopedEvidenceExists(draft.replayKey, childRunId)
				)
					return false;
				syntheticChildIds.add(childRunId);
				owners.set(childRunId, draft);
				continue;
			}
			const childRun = runTopologyFor(grouped.get(childRunId)!, toolsFor(childRunId));
			if (
				childRun?.parentRunId !== parentRunId ||
				childRun.parentStageId !== draft.topology?.stageId ||
				(childRun.rootRunId !== undefined && childRun.rootRunId !== rootRunId)
			)
				return false;
			owners.set(childRunId, draft);
		}
	}
	for (const [runId, drafts] of grouped) {
		if (
			runId !== rootRunId &&
			(runTopologyFor(drafts, toolsFor(runId)) === undefined || owners.get(runId) === undefined)
		)
			return false;
	}
	for (const runId of owners.keys()) {
		if (syntheticChildIds.has(runId)) continue;
		const seen = new Set<string>();
		let current: string | undefined = runId;
		while (current !== undefined && current !== rootRunId) {
			if (seen.has(current)) return false;
			seen.add(current);
			current = runTopologyFor(grouped.get(current) ?? [], toolsFor(current))?.parentRunId;
		}
		if (current !== rootRunId) return false;
	}
	return true;
}

/** A started child boundary whose run has not yet written any checkpoint of its own. */
export function isPendingChildBoundary(
	draft: StageDraft,
	parentRunId: string,
	childRunId: string,
	rootRunId: string,
): boolean {
	const boundary = draft.topology?.boundary;
	return (
		workflowChildFromDraft(draft) === undefined &&
		boundary?.event === "start" &&
		boundary.status === "running" &&
		boundary.child.runId === childRunId &&
		boundary.child.parentRunId === parentRunId &&
		boundary.child.parentStageId === draft.topology?.stageId &&
		boundary.child.rootRunId === rootRunId
	);
}

export function isSyntheticExitedChild(
	draft: StageDraft,
	parentRunId: string,
	childRunId: string,
	rootRunId: string,
): boolean {
	const child = workflowChildFromDraft(draft);
	const boundary = draft.topology?.boundary;
	return (
		child?.runId === childRunId &&
		child.exited === true &&
		boundary?.event === "terminal" &&
		boundary.status === "completed" &&
		boundary.child.runId === childRunId &&
		boundary.child.parentRunId === parentRunId &&
		boundary.child.parentStageId === draft.topology?.stageId &&
		boundary.child.rootRunId === rootRunId
	);
}

/**
 * Drop run groups the root cannot reach through live child links. Returns false when a dropped group is not
 * owned by a reachable failed or skipped boundary (or nested under one): only those settled subtrees are pruned
 * by design; any other unreachable group means the checkpoint graph is incomplete.
 */
export function retainReachableRunGroups(grouped: Map<string, StageDraft[]>, rootRunId: string): boolean {
	const reachable = new Set([rootRunId]);
	const settled = new Set<string>();
	const pending: Array<{ readonly runId: string; readonly live: boolean }> = [{ runId: rootRunId, live: true }];
	while (pending.length > 0) {
		const { runId, live } = pending.pop()!;
		const drafts = grouped.get(runId);
		if (drafts === undefined) continue;
		for (const draft of drafts) {
			const childRunId = workflowChildFromDraft(draft)?.runId ?? draft.topology?.boundary?.child.runId;
			if (childRunId === undefined || !grouped.has(childRunId)) continue;
			if (live && childRunIdFromDraft(draft) !== undefined) {
				if (reachable.has(childRunId)) continue;
				reachable.add(childRunId);
				pending.push({ runId: childRunId, live: true });
			} else if (!settled.has(childRunId)) {
				settled.add(childRunId);
				pending.push({ runId: childRunId, live: false });
			}
		}
	}
	let complete = true;
	for (const runId of grouped.keys()) {
		if (reachable.has(runId)) continue;
		if (!settled.has(runId)) complete = false;
		grouped.delete(runId);
	}
	return complete;
}

export function childRunIdFromDraft(draft: StageDraft): string | undefined {
	const boundary = draft.topology?.boundary;
	if (boundary !== undefined && (boundary.status === "failed" || boundary.status === "skipped")) return undefined;
	return workflowChildFromDraft(draft)?.runId ?? boundary?.child.runId;
}

export function childRunStatus(owner: StageDraft): RunSnapshot["status"] {
	const child = workflowChildFromDraft(owner);
	if (child !== undefined) return child.status;
	const status = owner.topology?.boundary?.status;
	return status === "failed" || status === "skipped" || status === "completed" ? status : "running";
}

export function mergeStageGroup(records: readonly DurableStageCheckpoint[], index: CheckpointCatalogIndex): StageDraft {
	let merged: StageDraft | undefined;
	for (const record of records) merged = mergeStageDraft(merged, record, index.sequence(record));
	const draft = merged!;
	const start = records.find((record) => record.topology?.boundary?.event === "start");
	if (start === undefined) return draft;
	const resolved = index.boundaryLifecycle(start, false);
	if ("error" in resolved) return draft;
	const terminal = resolved.lifecycle.latestTerminal;
	const { output: _output, result: _result, topology: _topology, ...identity } = draft;
	void _output;
	void _result;
	void _topology;
	if (terminal === undefined) return { ...identity, topology: start.topology };
	return {
		...identity,
		topology: terminal.topology,
		...(terminal.output !== undefined ? { output: terminal.output } : {}),
		...(terminal.output !== undefined && terminal.result !== undefined ? { result: terminal.result } : {}),
	};
}

export function mergeStageDraft(
	existing: StageDraft | undefined,
	checkpoint: DurableStageCheckpoint,
	sequence: number,
): StageDraft {
	return {
		replayKey: checkpoint.replayKey,
		name: existing?.name ?? checkpoint.name,
		firstSequence: existing?.firstSequence ?? sequence,
		sourceIds: [
			...new Set([
				...(existing?.sourceIds ?? []),
				...(checkpoint.topology?.stageId !== undefined ? [checkpoint.topology.stageId] : []),
			]),
		],
		firstCompletedAt: Math.min(existing?.firstCompletedAt ?? checkpoint.completedAt, checkpoint.completedAt),
		...valueOrExisting("output", checkpoint, existing),
		...valueOrExisting("result", checkpoint, existing),
		...valueOrExisting("sessionId", checkpoint, existing),
		...valueOrExisting("sessionFile", checkpoint, existing),
		...valueOrExisting("startedAt", checkpoint, existing),
		...valueOrExisting("endedAt", checkpoint, existing),
		...valueOrExisting("durationMs", checkpoint, existing),
		...valueOrExisting("model", checkpoint, existing),
		...valueOrExisting("thinkingLevel", checkpoint, existing),
		...valueOrExisting("attemptedModels", checkpoint, existing),
		...valueOrExisting("modelAttempts", checkpoint, existing),
		...valueOrExisting("rateLimits", checkpoint, existing),
		...valueOrExisting("routerSelection", checkpoint, existing),
		// A task result can settle after its stage checkpoint with only the
		// envelope's synthetic root topology. It must not erase owning-run identity.
		...(existing?.topology?.run !== undefined && checkpoint.topology?.run === undefined
			? { topology: existing.topology }
			: checkpoint.topology !== undefined
				? { topology: checkpoint.topology }
				: existing?.topology !== undefined
					? { topology: existing.topology }
					: {}),
	};
}

function valueOrExisting<
	K extends keyof Omit<StageDraft, "replayKey" | "name" | "firstCompletedAt" | "firstSequence" | "sourceIds">,
>(key: K, checkpoint: DurableStageCheckpoint, existing: StageDraft | undefined): Pick<StageDraft, K> | object {
	const checkpointValue = checkpoint[key];
	if (checkpointValue !== undefined) return { [key]: checkpointValue } as Pick<StageDraft, K>;
	const existingValue = existing?.[key];
	return existingValue === undefined ? {} : ({ [key]: existingValue } as Pick<StageDraft, K>);
}

export function workflowChildFromDraft(draft: StageDraft): StageSnapshot["workflowChild"] | undefined {
	const child = parseWorkflowChildResult(draft.output);
	if (child === undefined) return undefined;
	return {
		alias: child.workflow,
		workflow: child.workflow,
		runId: child.runId,
		status: child.status,
		exited: child.exited,
		outputs: child.outputs,
		...(typeof child.exitReason === "string" ? { exitReason: child.exitReason } : {}),
	};
}
