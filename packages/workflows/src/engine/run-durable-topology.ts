import { type DurableWorkflowBackend, durableHash } from "../durable/backend.js";
import { DurableNestedTopologyError } from "../durable/boundary-topology.js";
import { durableCompletedNestedRunSubtree } from "../durable/completed-subtree.js";
import {
	type DurableCompletedStageCheckpoint,
	type DurableStageDeps,
	recordCachedStageWithTracker,
	recordStageCheckpoint,
} from "../durable/stage-primitive.js";
import { durableStageCheckpointMetadata } from "../durable/stage-topology.js";
import { promptOccurrenceIdentityError } from "../durable/stage-topology-validation.js";
import type { DurableStageCheckpoint, DurableStageRunTopology, DurableStageTopology } from "../durable/types.js";
import { parseLegacyWorkflowChildResult, parseWorkflowChildResult } from "../durable/workflow-child-result.js";
import type { ParallelFailFastScope, RunOpts } from "../runs/foreground/executor-types.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { authoritativeWorkflowChildRunId, reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import type { GraphFrontierTracker } from "./graph-inference.js";

export function durableRunTopology(run: RunSnapshot): DurableStageRunTopology {
	return {
		runId: run.id,
		runName: run.name,
		...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
		...(run.parentStageId !== undefined ? { parentStageId: run.parentStageId } : {}),
		...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
	};
}

export function createDurableStageDeps(input: {
	readonly backend: DurableWorkflowBackend;
	readonly run: RunSnapshot;
	readonly nextCheckpointId: () => string;
	readonly nextReplayKey: (stageName: string) => string;
	readonly completedReplayKeys: Map<string, string>;
}): DurableStageDeps {
	return {
		workflowId: input.run.id,
		backend: input.backend,
		nextCheckpointId: input.nextCheckpointId,
		nextReplayKey: input.nextReplayKey,
		replayKeyForCompletedStage: (stage) => input.completedReplayKeys.get(stage.id),
		runTopology: durableRunTopology(input.run),
		sourceOrderForStage: (stage) => {
			const order = input.run.stages.findIndex((candidate) => candidate.id === stage.id);
			return order >= 0 ? order : undefined;
		},
	};
}

export function createDurableStageEndRecorder(input: {
	readonly rootRunId: string;
	readonly deps: DurableStageDeps;
	readonly user?: RunOpts["onStageEnd"];
	readonly metadataOnly?: boolean;
}): (runId: string, snapshot: StageSnapshot) => Promise<void> {
	return async (runId, snapshot): Promise<void> => {
		if (runId === input.rootRunId) {
			await recordStageCheckpoint(input.deps, snapshot, { metadataOnly: input.metadataOnly });
		}
		await input.user?.(runId, snapshot);
	};
}

/** Snapshot prior-process stage identities so live writes cannot be mistaken for resume topology. */
export function createDurableStageTopologyResolver(
	backend: DurableWorkflowBackend,
	workflowId: string,
): (replayKey: string) => DurableStageTopology | undefined {
	const byReplayKey = new Map<string, Map<string, DurableStageTopology>>();
	const ownedStages: DurableStageCheckpoint[] = [];
	for (const checkpoint of backend.listCheckpoints(workflowId)) {
		if (checkpoint.kind !== "stage" || checkpoint.topology === undefined) continue;
		const topology = checkpoint.topology;
		if (topology.run !== undefined && topology.run.runId !== workflowId) continue;
		ownedStages.push(checkpoint);
		const byStage = byReplayKey.get(checkpoint.replayKey) ?? new Map<string, DurableStageTopology>();
		byStage.set(topology.stageId, topology);
		byReplayKey.set(checkpoint.replayKey, byStage);
	}
	const occurrenceError = promptOccurrenceIdentityError(ownedStages);
	const queues = new Map<string, readonly DurableStageTopology[]>();
	for (const [replayKey, byStage] of byReplayKey) {
		const stages = [...byStage.values()];
		const sourceOrders = stages.map((stage) => stage.sourceOrder);
		const safe =
			stages.length <= 1 ||
			(sourceOrders.every((order) => order !== undefined) && new Set(sourceOrders).size === sourceOrders.length);
		queues.set(
			replayKey,
			safe ? stages.sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0)) : [],
		);
	}
	const indexes = new Map<string, number>();
	return (replayKey): DurableStageTopology | undefined => {
		if (occurrenceError !== undefined) throw new DurableNestedTopologyError(occurrenceError);
		const index = indexes.get(replayKey) ?? 0;
		indexes.set(replayKey, index + 1);
		return queues.get(replayKey)?.[index];
	};
}

/** Persist an in-progress stage identity before an external wait can outlive this process. */
export async function recordDurableActiveStage(deps: DurableStageDeps, stage: StageSnapshot): Promise<boolean> {
	if (
		stage.replayKey === undefined ||
		stage.status === "completed" ||
		stage.status === "failed" ||
		stage.status === "skipped"
	)
		return false;
	await deps.backend.recordCheckpointAsync({
		kind: "stage",
		workflowId: deps.workflowId,
		checkpointId: `stage-active-meta:${durableHash({ replayKey: stage.replayKey, stageId: stage.id })}`,
		name: stage.name,
		replayKey: stage.replayKey,
		completedAt: Date.now(),
		...durableStageCheckpointMetadata(stage, deps.runTopology, deps.sourceOrderForStage?.(stage)),
	});
	return true;
}

export function createDurableCachedStageRecorder(input: {
	readonly store: Store;
	readonly tracker: GraphFrontierTracker;
	readonly run: RunSnapshot;
	readonly backend: DurableWorkflowBackend;
	readonly rootBackend: DurableWorkflowBackend;
	readonly completedStageReplayKeys: Map<string, string>;
	readonly sourceToReplayedNodeIds: Map<string, string>;
}): {
	readonly record: (
		name: string,
		replayKey: string,
		checkpoint: DurableCompletedStageCheckpoint,
		scope?: ParallelFailFastScope,
	) => void;
	readonly metadata: (replayKey: string) => Partial<DurableCompletedStageCheckpoint>;
} {
	const replaySourceOrders = new Map<string, number>();
	return {
		record(name, replayKey, checkpoint, scope): void {
			const cachedChildRunId = workflowChildRunId(checkpoint);
			const runById = new Map(input.store.runs().map((run) => [run.id, run]));
			if (!runById.has(input.run.id)) runById.set(input.run.id, input.run);
			const durableRootId = reciprocalWorkflowRootRunId(runById, input.run.id);
			const cachedDescendants =
				cachedChildRunId === undefined || durableRootId === undefined
					? undefined
					: durableCompletedNestedRunSubtree(input.rootBackend, durableRootId, cachedChildRunId);
			if (cachedChildRunId !== undefined && durableRootId !== undefined && cachedDescendants === undefined) {
				throw new DurableNestedTopologyError(
					`cached completed child subtree is incomplete or inconsistent at ${replayKey}`,
				);
			}
			recordCachedStageWithTracker(
				input.store,
				input.tracker,
				input.run.id,
				name,
				replayKey,
				checkpoint,
				input.completedStageReplayKeys,
				scope,
				input.sourceToReplayedNodeIds,
			);
			const sourceOrder = checkpoint.topology?.sourceOrder;
			if (sourceOrder !== undefined) {
				const replayedStage = input.run.stages.find((candidate) => candidate.replayKey === replayKey);
				if (replayedStage !== undefined) replaySourceOrders.set(replayedStage.id, sourceOrder);
				input.run.stages.sort(
					(left, right) =>
						(replaySourceOrders.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
						(replaySourceOrders.get(right.id) ?? Number.MAX_SAFE_INTEGER),
				);
			}
			const stage = input.store
				.runs()
				.find((run) => run.id === input.run.id)
				?.stages.find((candidate) => candidate.replayKey === replayKey);
			if (stage !== undefined) {
				input.backend.recordCheckpoint({
					kind: "stage",
					workflowId: input.run.id,
					checkpointId: `stage-replay-meta:${durableHash({ replayKey, stageId: stage.id, parentIds: stage.parentIds })}`,
					name,
					replayKey,
					completedAt: Date.now(),
					...durableStageCheckpointMetadata(
						stage,
						durableRunTopology(input.run),
						sourceOrder ?? input.run.stages.findIndex((candidate) => candidate.id === stage.id),
					),
				});
			}
			for (const childRun of cachedDescendants ?? []) {
				const existingRun = input.store.runs().find((candidate) => candidate.id === childRun.id);
				const isDirectChild =
					childRun.id === cachedChildRunId &&
					childRun.parentRunId === input.run.id &&
					stage?.workflowChild?.runId === cachedChildRunId;
				if (existingRun !== undefined) {
					if (stage !== undefined && isDirectChild) {
						reconcileCachedDirectChildParentStage({
							store: input.store,
							parentRun: input.run,
							catalogRun: childRun,
							checkpointChildRunId: cachedChildRunId!,
							boundary: stage,
						});
					}
					continue;
				}
				const hydratedRun =
					isDirectChild && stage !== undefined ? { ...childRun, parentStageId: stage.id } : childRun;
				input.store.recordRunStart(hydratedRun);
			}
		},
		metadata(replayKey) {
			const stage = input.run.stages.find((candidate) => candidate.replayKey === replayKey);
			return stage === undefined
				? {}
				: durableStageCheckpointMetadata(
						stage,
						durableRunTopology(input.run),
						input.run.stages.findIndex((candidate) => candidate.id === stage.id),
					);
		},
	};
}

export function reconcileCachedDirectChildParentStage(input: {
	readonly store: Store;
	readonly parentRun: RunSnapshot;
	readonly catalogRun: RunSnapshot;
	readonly checkpointChildRunId: string;
	readonly boundary: StageSnapshot;
}): boolean {
	const existingRun = input.store.runs().find((run) => run.id === input.checkpointChildRunId);
	const runById = new Map(input.store.runs().map((run) => [run.id, run]));
	const storedParentRun = runById.get(input.parentRun.id);
	if (
		storedParentRun !== undefined &&
		(storedParentRun.parentRunId !== input.parentRun.parentRunId ||
			storedParentRun.parentStageId !== input.parentRun.parentStageId)
	)
		return false;
	if (storedParentRun === undefined) runById.set(input.parentRun.id, input.parentRun);
	const expectedRootRunId = reciprocalWorkflowRootRunId(runById, input.parentRun.id);
	if (expectedRootRunId === undefined) return false;
	const storedBoundary = storedParentRun?.stages.find((stage) => stage.id === input.boundary.id);
	if (
		!rootMatches(input.parentRun.rootRunId, expectedRootRunId) ||
		!rootMatches(storedParentRun?.rootRunId, expectedRootRunId) ||
		authoritativeWorkflowChildRunId(input.boundary) !== input.checkpointChildRunId ||
		(storedParentRun !== undefined &&
			authoritativeWorkflowChildRunId(storedBoundary) !== input.checkpointChildRunId) ||
		input.catalogRun.id !== input.checkpointChildRunId ||
		existingRun?.status !== "completed" ||
		input.catalogRun.status !== "completed" ||
		existingRun.parentRunId !== input.parentRun.id ||
		input.catalogRun.parentRunId !== input.parentRun.id ||
		input.catalogRun.parentStageId === undefined ||
		existingRun.parentStageId !== input.catalogRun.parentStageId ||
		!rootMatches(existingRun.rootRunId, expectedRootRunId) ||
		!rootMatches(input.catalogRun.rootRunId, expectedRootRunId)
	)
		return false;
	return input.store.reconcileRunParentStage(existingRun.id, input.catalogRun.parentStageId, input.boundary.id);
}

function rootMatches(rootRunId: string | undefined, expectedRootRunId: string): boolean {
	return rootRunId === undefined || rootRunId === expectedRootRunId;
}

function workflowChildRunId(checkpoint: DurableCompletedStageCheckpoint): string | undefined {
	const topology = checkpoint.topology;
	const hasCurrentIdentity =
		topology?.sourceOrder !== undefined ||
		topology?.status !== undefined ||
		topology?.occurrenceKey !== undefined ||
		topology?.boundary !== undefined;
	return (
		parseWorkflowChildResult(checkpoint.output) ??
		(hasCurrentIdentity ? undefined : parseLegacyWorkflowChildResult(checkpoint.output))
	)?.runId;
}
