import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
	type DurableStageLifecycleStatus,
	type DurableStageRunTopology,
	type DurableStageTopology,
} from "./types.js";

/** Immutable source identity must agree before lifecycle records are merged. */
export function immutableStageGroupError(stages: readonly DurableStageCheckpoint[]): string | undefined {
	const occurrenceError = promptOccurrenceIdentityError(stages);
	if (occurrenceError !== undefined) return occurrenceError;
	const byReplayKey = groupByDurableStageKey(stages);
	for (const group of byReplayKey.values()) {
		const firstName = group[0]?.name;
		if (group.some((stage) => stage.name !== firstName)) return "stage name drift within one replay-key group";
		const topologies = group.flatMap((stage) => (stage.topology === undefined ? [] : [stage.topology]));
		const first = topologies[0];
		if (first === undefined) continue;
		if (
			topologies.some(
				(topology) =>
					topology.version !== DURABLE_STAGE_TOPOLOGY_VERSION ||
					topology.stageId !== first.stageId ||
					!sameStrings(topology.parentIds, first.parentIds) ||
					topology.sourceOrder !== first.sourceOrder ||
					!sameOptionalRun(topology.run, first.run),
			)
		) {
			return "immutable stage identity drift within one replay-key group";
		}
	}
	return undefined;
}

/** Validate the complete direct-child DAG before any scoped cache can be exposed. */
export function directChildTopologyError(
	stages: readonly DurableStageCheckpoint[],
	replayScope: string,
	expectedRun: DurableStageRunTopology,
	allowedNodeIds: ReadonlySet<string> = new Set(),
): string | undefined {
	return directChildTopologyErrorFromRecords(
		{
			claiming: stages.filter((stage) => stage.topology?.run?.runId === expectedRun.runId),
			direct: (claiming) => {
				const directKeys = new Set(claiming.map((stage) => durableStageGroupKey(stage)));
				return stages.filter((stage) => directKeys.has(durableStageGroupKey(stage)));
			},
		},
		replayScope,
		expectedRun,
		allowedNodeIds,
	);
}

/** Records one direct-child validation reads, so indexed callers can supply them without rescanning. */
export interface DirectChildTopologyRecords {
	/** Stage records whose run topology claims the expected child run, in checkpoint order. */
	readonly claiming: readonly DurableStageCheckpoint[];
	/** Every stage record sharing a durable group key with `claiming`, in checkpoint order. */
	readonly direct: (claiming: readonly DurableStageCheckpoint[]) => readonly DurableStageCheckpoint[];
}

/** {@link directChildTopologyError} over records the caller has already selected. */
export function directChildTopologyErrorFromRecords(
	records: DirectChildTopologyRecords,
	replayScope: string,
	expectedRun: DurableStageRunTopology,
	allowedNodeIds: ReadonlySet<string> = new Set(),
): string | undefined {
	const prefix = `${replayScope}:`;
	const claiming = records.claiming;
	if (claiming.some((stage) => !stage.replayKey.startsWith(prefix))) {
		return "child run topology exists outside its durable invocation scope";
	}
	if (claiming.some((stage) => !sameRun(stage.topology?.run, expectedRun))) {
		return "child checkpoint ownership is not reciprocal";
	}

	const direct = records.direct(claiming);
	const immutableError = immutableStageGroupError(direct);
	if (immutableError !== undefined) return immutableError;

	const superseded = supersededPromptGroupKeys(direct);
	const merged: DurableStageTopology[] = [];
	for (const [key, group] of groupByDurableStageKey(direct)) {
		if (superseded.has(key)) continue;
		const topology = group.find((stage) => stage.topology?.run?.runId === expectedRun.runId)?.topology;
		if (topology === undefined) return "direct child stage group lacks owning-run topology";
		if (topology.version !== DURABLE_STAGE_TOPOLOGY_VERSION || topology.sourceOrder === undefined) {
			return "direct child stage topology lacks current source identity";
		}
		if (topology.stageId.length === 0) return "direct child stage id is empty";
		merged.push(topology);
	}

	const ids = new Set<string>(allowedNodeIds);
	const stageIds = new Set<string>();
	const orders = new Set<number>();
	for (const topology of merged) {
		if (stageIds.has(topology.stageId) || ids.has(topology.stageId)) return "direct child stage ids are not unique";
		stageIds.add(topology.stageId);
		ids.add(topology.stageId);
		if (topology.sourceOrder !== undefined) {
			if (orders.has(topology.sourceOrder)) return "direct child source orders are not unique";
			orders.add(topology.sourceOrder);
		}
	}
	if (merged.some((topology) => topology.parentIds.some((parentId) => !ids.has(parentId)))) {
		return "direct child stage references an unknown parent";
	}
	return hasCycle(merged) ? "direct child stage topology contains a cycle" : undefined;
}

export function owningBoundaryIdError(
	stages: readonly DurableStageCheckpoint[],
	owningRunId: string,
): string | undefined {
	const starts = stages.filter(
		(stage) => stage.topology?.run?.runId === owningRunId && stage.topology.boundary?.event === "start",
	);
	const seen = new Map<string, string>();
	for (const start of starts) {
		const stageId = start.topology!.stageId;
		if (stageId.length === 0) return "owning-run boundary stage id is empty";
		const prior = seen.get(stageId);
		if (prior !== undefined && prior !== start.replayKey) return "owning-run boundary stage id is aliased";
		seen.set(stageId, start.replayKey);
	}
	return undefined;
}

export function sameRun(actual: DurableStageRunTopology | undefined, expected: DurableStageRunTopology): boolean {
	return (
		actual !== undefined &&
		actual.runId === expected.runId &&
		actual.runName === expected.runName &&
		actual.parentRunId === expected.parentRunId &&
		actual.parentStageId === expected.parentStageId &&
		actual.rootRunId === expected.rootRunId
	);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOptionalRun(
	actual: DurableStageRunTopology | undefined,
	expected: DurableStageRunTopology | undefined,
): boolean {
	if (actual === undefined || expected === undefined) return actual === expected;
	return sameRun(actual, expected);
}

/** Reject prompt occurrence metadata that aliases another logical replay identity. */
export function promptOccurrenceIdentityError(stages: readonly DurableStageCheckpoint[]): string | undefined {
	const replayByOccurrence = new Map<string, string>();
	const occurrenceByReplayStage = new Map<string, string>();
	const stageByReplayOccurrence = new Map<string, string>();
	for (const stage of stages) {
		const topology = stage.topology;
		const occurrence = topology?.occurrenceKey;
		if (topology === undefined || occurrence === undefined) continue;
		const priorReplay = replayByOccurrence.get(occurrence);
		if (priorReplay !== undefined && priorReplay !== stage.replayKey) {
			return "prompt occurrence is bound to multiple replay keys";
		}
		replayByOccurrence.set(occurrence, stage.replayKey);
		const replayStage = compositeKey("prompt-stage", stage.replayKey, topology.stageId);
		const priorOccurrence = occurrenceByReplayStage.get(replayStage);
		if (priorOccurrence !== undefined && priorOccurrence !== occurrence) {
			return "prompt stage identity is bound to multiple occurrences";
		}
		occurrenceByReplayStage.set(replayStage, occurrence);
		const replayOccurrence = compositeKey("prompt-occurrence", stage.replayKey, occurrence);
		const priorStage = stageByReplayOccurrence.get(replayOccurrence);
		if (priorStage !== undefined && priorStage !== topology.stageId) {
			return "prompt occurrence is bound to multiple stage identities";
		}
		stageByReplayOccurrence.set(replayOccurrence, topology.stageId);
	}
	return undefined;
}

/**
 * A prompt occurrence that was asked but never answered, failed or skipped: the run waited on it
 * and went no further, so nothing in the run depends on it.
 */
function isUnansweredPromptGroup(group: readonly DurableStageCheckpoint[]): boolean {
	return group.every(
		(stage) =>
			stage.topology?.occurrenceKey !== undefined &&
			stage.topology.boundary === undefined &&
			stage.topology.status !== undefined &&
			UNANSWERED_PROMPT_STATUSES.has(stage.topology.status),
	);
}

const UNANSWERED_PROMPT_STATUSES: ReadonlySet<DurableStageLifecycleStatus> = new Set([
	"pending",
	"running",
	"awaiting_input",
	"paused",
	"blocked",
]);

/**
 * The durable group keys ({@link durableStageGroupKey}) of prompts an attempt asked and never got
 * answered that a later ask at the same source position of the same run replaced (#4022). A
 * replacement attempt of a child re-runs its code and asks again at the same position; when the
 * prompt's text depends on data, the new ask is a different durable prompt. The unanswered one is
 * superseded, not a second node at that position: the run never got past it. Among unanswered
 * prompts alone at one position, the latest ask (in record order) stands. Any other collision stays
 * a source-order conflict. Every check of saved stages (live checkpoint validation, completed-run
 * rebuild, cached-child replay, inspection) leaves these groups out, so they agree.
 */
export function supersededPromptGroupKeys(stages: readonly DurableStageCheckpoint[]): ReadonlySet<string> {
	const byPosition = new Map<string, { readonly key: string; readonly unanswered: boolean }[]>();
	for (const [key, group] of groupByDurableStageKey(stages)) {
		const topology = group.find((stage) => stage.topology !== undefined)?.topology;
		if (topology?.sourceOrder === undefined) continue;
		const position = JSON.stringify([topology.run?.runId ?? null, topology.sourceOrder]);
		const atPosition = byPosition.get(position) ?? [];
		atPosition.push({ key, unanswered: isUnansweredPromptGroup(group) });
		byPosition.set(position, atPosition);
	}
	const superseded = new Set<string>();
	for (const atPosition of byPosition.values()) {
		if (atPosition.length < 2 || !atPosition.some((candidate) => candidate.unanswered)) continue;
		const answered = atPosition.filter((candidate) => !candidate.unanswered);
		// Answered stages at one position are kept (two of them remain a conflict); unanswered asks give way
		// to the stage that replaced them, or to the latest unanswered ask.
		const kept = answered.length > 0 ? answered : [atPosition[atPosition.length - 1]!];
		for (const candidate of atPosition)
			if (candidate.unanswered && !kept.includes(candidate)) superseded.add(candidate.key);
	}
	return superseded;
}

/** Group prompt occurrences by replay + occurrence while retaining strict non-prompt replay grouping. */
export function durableStageGroupKey(stage: DurableStageCheckpoint): string {
	const occurrence = stage.topology?.occurrenceKey;
	return occurrence === undefined
		? compositeKey("stage-replay", stage.replayKey)
		: compositeKey("prompt-occurrence", stage.replayKey, occurrence);
}

export function groupByDurableStageKey(
	stages: readonly DurableStageCheckpoint[],
): Map<string, DurableStageCheckpoint[]> {
	const groups = new Map<string, DurableStageCheckpoint[]>();
	for (const stage of stages) {
		const key = durableStageGroupKey(stage);
		const group = groups.get(key) ?? [];
		group.push(stage);
		groups.set(key, group);
	}
	return groups;
}

function compositeKey(domain: string, ...parts: readonly string[]): string {
	return JSON.stringify([domain, ...parts]);
}

function hasCycle(topologies: readonly DurableStageTopology[]): boolean {
	const parents = new Map(topologies.map((topology) => [topology.stageId, topology.parentIds]));
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
	return topologies.some((topology) => cyclic(topology.stageId));
}
