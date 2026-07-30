import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { boundaryTransitionError, resolveBoundaryLifecycle } from "./boundary-lifecycle.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableStageRunTopology,
	DurableToolCheckpoint,
} from "./types.js";
import { parseLegacyWorkflowChildResult, parseWorkflowChildResult } from "./workflow-child-result.js";

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
	readonly fastMode?: boolean;
	readonly attemptedModels?: readonly string[];
	readonly modelAttempts?: DurableStageCheckpoint["modelAttempts"];
	readonly topology?: DurableStageCheckpoint["topology"];
}

export function validBoundaryRecordSet(checkpoints: readonly DurableCheckpoint[], strict: boolean): boolean {
	const stages = checkpoints.filter((item): item is DurableStageCheckpoint => item.kind === "stage");
	const boundaries = stages.filter((item) => item.topology?.boundary !== undefined);
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
	return [...startsByReplay.values()].every(
		(starts) => boundaryTransitionError(starts[0]!, stages, strict) === undefined,
	);
}

export function validStageGroup(
	drafts: readonly StageDraft[],
	runId: string,
	allowedNodeIds: ReadonlySet<string> = new Set(),
): boolean {
	if (drafts.some((draft) => draft.topology!.stageId.length === 0)) return false;
	const stageIds = new Set(drafts.map((draft) => draft.topology!.stageId));
	if (stageIds.size !== drafts.length) return false;
	const ids = new Set([...allowedNodeIds, ...stageIds]);
	if (ids.size !== allowedNodeIds.size + stageIds.size) return false;
	const orders = drafts.flatMap((draft) =>
		draft.topology!.sourceOrder === undefined ? [] : [draft.topology!.sourceOrder],
	);
	if (new Set(orders).size !== orders.length) return false;
	if (drafts.some((draft) => draft.topology!.parentIds.some((parentId) => !ids.has(parentId)))) return false;
	const runs = drafts.flatMap((draft) => (draft.topology?.run === undefined ? [] : [draft.topology.run]));
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
	const parents = new Map(drafts.map((draft) => [draft.topology!.stageId, draft.topology!.parentIds]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const cyclic = (stageId: string): boolean => {
		if (visiting.has(stageId)) return true;
		if (visited.has(stageId)) return false;
		visiting.add(stageId);
		if ((parents.get(stageId) ?? []).some(cyclic)) return true;
		visiting.delete(stageId);
		visited.add(stageId);
		return false;
	};
	return ![...stageIds].some(cyclic);
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
	tools: readonly DurableToolCheckpoint[],
): boolean {
	const toolsFor = (runId: string) =>
		tools.filter((checkpoint) => (checkpoint.topology?.run?.runId ?? rootRunId) === runId);
	const owners = new Map<string, StageDraft>();
	for (const [parentRunId, drafts] of grouped) {
		for (const draft of drafts) {
			const childRunId = childRunIdFromDraft(draft);
			if (childRunId === undefined) continue;
			if (!grouped.has(childRunId) || childRunId === parentRunId || owners.has(childRunId)) return false;
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

export function retainReachableRunGroups(grouped: Map<string, StageDraft[]>, rootRunId: string): void {
	const reachable = new Set([rootRunId]);
	const pending = [rootRunId];
	while (pending.length > 0) {
		const drafts = grouped.get(pending.pop()!);
		if (drafts === undefined) continue;
		for (const draft of drafts) {
			const childRunId = childRunIdFromDraft(draft);
			if (childRunId === undefined || reachable.has(childRunId) || !grouped.has(childRunId)) continue;
			reachable.add(childRunId);
			pending.push(childRunId);
		}
	}
	for (const runId of grouped.keys()) if (!reachable.has(runId)) grouped.delete(runId);
}

export function childRunIdFromDraft(draft: StageDraft): string | undefined {
	const boundary = draft.topology?.boundary;
	if (boundary !== undefined && (boundary.status === "failed" || boundary.status === "skipped")) return undefined;
	return workflowChildFromDraft(draft)?.runId ?? boundary?.child.runId;
}

export function boundaryOwner(grouped: Map<string, StageDraft[]>, childRunId: string): StageDraft | undefined {
	for (const drafts of grouped.values()) {
		const owner = drafts.find((draft) => childRunIdFromDraft(draft) === childRunId);
		if (owner !== undefined) return owner;
	}
	return undefined;
}

export function childRunStatus(owner: StageDraft): RunSnapshot["status"] {
	const child = workflowChildFromDraft(owner);
	if (child !== undefined) return child.status;
	const status = owner.topology?.boundary?.status;
	return status === "failed" || status === "skipped" || status === "completed" ? status : "running";
}

export function mergeStageGroup(
	records: readonly DurableStageCheckpoint[],
	allStages: readonly DurableStageCheckpoint[],
	allCheckpoints: readonly DurableCheckpoint[],
): StageDraft {
	let merged: StageDraft | undefined;
	for (const record of records) merged = mergeStageDraft(merged, record, allCheckpoints.indexOf(record) + 1);
	const draft = merged!;
	const start = records.find((record) => record.topology?.boundary?.event === "start");
	if (start === undefined) return draft;
	const resolved = resolveBoundaryLifecycle(start, allStages, false);
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
		...valueOrExisting("fastMode", checkpoint, existing),
		...valueOrExisting("attemptedModels", checkpoint, existing),
		...valueOrExisting("modelAttempts", checkpoint, existing),
		...(checkpoint.topology !== undefined
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
	const strict = parseWorkflowChildResult(draft.output);
	const child = strict ?? (hasCurrentStageIdentity(draft) ? undefined : parseLegacyWorkflowChildResult(draft.output));
	if (child === undefined) return undefined;
	return {
		alias: child.workflow,
		workflow: child.workflow,
		runId: child.runId,
		status: child.status,
		...(child.exited !== undefined ? { exited: child.exited } : {}),
		outputs: child.outputs,
		...(typeof child.exitReason === "string" ? { exitReason: child.exitReason } : {}),
	};
}

function hasCurrentStageIdentity(draft: StageDraft): boolean {
	return (
		draft.topology?.sourceOrder !== undefined ||
		draft.topology?.status !== undefined ||
		draft.topology?.occurrenceKey !== undefined ||
		draft.topology?.boundary !== undefined
	);
}
