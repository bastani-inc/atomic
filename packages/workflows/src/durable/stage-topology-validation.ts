import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	type DurableStageCheckpoint,
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
	requireCurrentIdentity = true,
	allowedNodeIds: ReadonlySet<string> = new Set(),
): string | undefined {
	const prefix = `${replayScope}:`;
	const claiming = stages.filter((stage) => stage.topology?.run?.runId === expectedRun.runId);
	if (claiming.some((stage) => !stage.replayKey.startsWith(prefix))) {
		return "child run topology exists outside its durable invocation scope";
	}
	if (claiming.some((stage) => !sameRun(stage.topology?.run, expectedRun))) {
		return "child checkpoint ownership is not reciprocal";
	}

	const directKeys = new Set(claiming.map((stage) => durableStageGroupKey(stage, stages)));
	const direct = stages.filter((stage) => directKeys.has(durableStageGroupKey(stage, stages)));
	const immutableError = immutableStageGroupError(direct);
	if (immutableError !== undefined) return immutableError;

	const merged: DurableStageTopology[] = [];
	for (const group of groupByDurableStageKey(direct).values()) {
		const topology = group.find((stage) => stage.topology?.run?.runId === expectedRun.runId)?.topology;
		if (topology === undefined) return "direct child stage group lacks owning-run topology";
		if (
			topology.version !== DURABLE_STAGE_TOPOLOGY_VERSION ||
			(requireCurrentIdentity && topology.sourceOrder === undefined)
		) {
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
	for (const legacy of stages) {
		if (legacy.topology === undefined || legacy.topology.occurrenceKey !== undefined) continue;
		const matches = stages.filter(
			(current) =>
				current.topology?.occurrenceKey !== undefined &&
				current.replayKey === legacy.replayKey &&
				current.topology.stageId === legacy.topology?.stageId,
		);
		if (matches.some((current) => !samePromptOccurrenceIdentity(legacy, current))) {
			return "legacy prompt occurrence immutable identity drifted from current metadata";
		}
	}
	return undefined;
}

/** Group prompt occurrences by replay + occurrence while retaining strict non-prompt replay grouping. */
export function durableStageGroupKey(
	stage: DurableStageCheckpoint,
	stages: readonly DurableStageCheckpoint[] = [stage],
): string {
	const occurrence = stage.topology?.occurrenceKey ?? matchingCurrentOccurrence(stage, stages);
	return occurrence === undefined
		? compositeKey("stage-replay", stage.replayKey)
		: compositeKey("prompt-occurrence", stage.replayKey, occurrence);
}

export function groupByDurableStageKey(
	stages: readonly DurableStageCheckpoint[],
): Map<string, DurableStageCheckpoint[]> {
	const groups = new Map<string, DurableStageCheckpoint[]>();
	for (const stage of stages) {
		const key = durableStageGroupKey(stage, stages);
		const group = groups.get(key) ?? [];
		group.push(stage);
		groups.set(key, group);
	}
	return groups;
}

function matchingCurrentOccurrence(
	legacy: DurableStageCheckpoint,
	stages: readonly DurableStageCheckpoint[],
): string | undefined {
	if (legacy.topology === undefined) return undefined;
	const matches = stages.filter(
		(current) =>
			current.topology?.occurrenceKey !== undefined &&
			current.replayKey === legacy.replayKey &&
			current.topology.stageId === legacy.topology?.stageId &&
			samePromptOccurrenceIdentity(legacy, current),
	);
	const occurrences = new Set(matches.map((current) => current.topology!.occurrenceKey!));
	return occurrences.size === 1 ? occurrences.values().next().value : undefined;
}

function samePromptOccurrenceIdentity(legacy: DurableStageCheckpoint, current: DurableStageCheckpoint): boolean {
	const left = legacy.topology;
	const right = current.topology;
	return (
		left !== undefined &&
		right !== undefined &&
		legacy.name === current.name &&
		left.version === right.version &&
		left.stageId === right.stageId &&
		sameStrings(left.parentIds, right.parentIds) &&
		left.sourceOrder === right.sourceOrder &&
		sameOptionalRun(left.run, right.run) &&
		left.boundary === undefined &&
		right.boundary === undefined
	);
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
