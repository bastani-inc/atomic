import type { DurableBoundaryRuntimeIdentity } from "../../durable/boundary-topology.js";
import { DurableNestedTopologyError } from "../../durable/boundary-topology.js";
import { parseWorkflowChildResult } from "../../durable/workflow-child-result.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { EngineWorkflowBoundaryOptions } from "../../engine/options.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import type { Store } from "../../shared/store.js";
import type {
	RunSnapshot,
	StageSnapshot,
	WorkflowChildReplaySnapshot,
	WorkflowChildRunRef,
} from "../../shared/store-types.js";
import { elapsedStageMs, stageTimingFields } from "../../shared/timing.js";
import type { WorkflowChildResult, WorkflowSerializableValue } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import { makeParentWorkflowExitAbortReason } from "./executor-abort.js";
import { cloneWorkflowChildReplaySnapshot, cloneWorkflowChildValue } from "./executor-child-helpers.js";
import type { ContinuationReplayIndex } from "./executor-continuation.js";
import { sameStringSet } from "./executor-continuation.js";
import { applyFailureToStage, stageReplayFields } from "./executor-lifecycle.js";
import type { WorkflowExitCleanup } from "./executor-types.js";

interface LinkedChildWorkflowExitState {
	readonly ref: WorkflowChildRunRef;
	readonly controller: AbortController;
	runPromise?: Promise<unknown>;
}

export interface WorkflowBoundaryStage {
	readonly id: string;
	readonly parentIds: readonly string[];
	readonly sourceOrder: number;
	readonly replayedChild?: WorkflowChildResult;
	finalizeReplay(): Promise<void>;
	linkChildRun(ref: WorkflowChildRunRef, childController: AbortController): Promise<void>;
	observeChildRun(promise: Promise<unknown>): void;
	complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): Promise<void>;
	skipForWorkflowExit(reason?: string): Promise<void>;
	fail(error: unknown): Promise<void>;
}

function workflowChildResultFromReplay(snapshot: WorkflowChildReplaySnapshot): WorkflowChildResult {
	const candidate: WorkflowSerializableValue = {
		workflow: snapshot.workflow,
		runId: snapshot.runId,
		status: snapshot.status,
		...(snapshot.exited !== undefined ? { exited: snapshot.exited } : {}),
		outputs: cloneWorkflowChildValue(snapshot.outputs),
		...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
	};
	const parsed = parseWorkflowChildResult(candidate);
	if (parsed === undefined) {
		throw new DurableNestedTopologyError(
			"continuation child result has an invalid exited/status/output discriminant",
		);
	}
	return parsed;
}

function requestLinkedChildWorkflowExit(linkedChild: LinkedChildWorkflowExitState, reason?: string): void {
	if (!linkedChild.controller.signal.aborted) {
		linkedChild.controller.abort(makeParentWorkflowExitAbortReason(reason));
	}
}

async function waitForLinkedChildWorkflowExit(linkedChild: LinkedChildWorkflowExitState): Promise<void> {
	const childRun = linkedChild.runPromise;
	if (childRun === undefined) return;
	try {
		await childRun;
	} catch {
		// Parent exit cleanup intentionally swallows child teardown failures.
	}
}

export function createWorkflowBoundaryFactory(input: {
	readonly runId: string;
	readonly runSnapshot: RunSnapshot;
	readonly activeStore: Store;
	readonly opts: EngineWorkflowBoundaryOptions;
	readonly tracker: GraphFrontierTracker;
	readonly replayIndex: ContinuationReplayIndex;
	readonly registerWorkflowExitCleanup: (stageId: string, cleanup: WorkflowExitCleanup) => () => void;
	readonly workflowExitSkippedReason: (reason?: string) => string;
	readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
}): (name: string, replayKey: string, identity?: DurableBoundaryRuntimeIdentity) => WorkflowBoundaryStage {
	return (name: string, replayKey: string, identity?: DurableBoundaryRuntimeIdentity): WorkflowBoundaryStage => {
		const stageId = identity?.boundaryId ?? crypto.randomUUID();
		const sourceOrder = identity?.sourceOrder ?? input.runSnapshot.stages.length;
		const provisionalParentIds = input.tracker.onSpawn(stageId, name);
		const replayDecision = input.replayIndex.decide({
			displayName: name,
			replayKey,
			parentIds: provisionalParentIds,
			stageId,
			kind: "workflow",
		});
		const parentIds = identity?.parentIds ?? replayDecision.parentIds;
		if (!sameStringSet(parentIds, provisionalParentIds)) input.tracker.replaceParents(stageId, parentIds);
		const replaySource = replayDecision.source;
		const replayChildSnapshot = replayDecision.kind === "replay" ? replayDecision.source.workflowChild : undefined;
		const replayedChild =
			replayChildSnapshot !== undefined ? workflowChildResultFromReplay(replayChildSnapshot) : undefined;
		const startedAt = Date.now();
		const stageSnapshot: StageSnapshot = {
			id: stageId,
			name,
			replayKey,
			status: replayedChild !== undefined ? "completed" : "running",
			parentIds: Object.freeze([...parentIds]),
			...(replayedChild === undefined ? { startedAt } : stageTimingFields(replaySource)),
			toolEvents: [],
			attachable: false,
			...(replaySource !== undefined
				? { replayedFromStageId: replaySource.id, replayed: replayedChild !== undefined }
				: {}),
			...(replayedChild !== undefined && replayChildSnapshot !== undefined
				? {
						...(replayDecision.kind === "replay" && replayDecision.source.result !== undefined
							? { result: replayDecision.source.result }
							: {}),
						workflowChild: cloneWorkflowChildReplaySnapshot(replayChildSnapshot),
					}
				: {}),
		};
		let finalized = false;
		let unregisterWorkflowExitCleanup = (): void => {};
		let linkedChild: LinkedChildWorkflowExitState | undefined;

		let stageStartEntry: Promise<void> | undefined;
		let finalization: Promise<void> | undefined;
		const appendStageStartOnce = (): Promise<void> => {
			if (!input.opts.persistence) return Promise.resolve();
			stageStartEntry ??= appendStageStart(input.opts.persistence, {
				runId: input.runId,
				stageId,
				name,
				parentIds: stageSnapshot.parentIds,
				...stageReplayFields(stageSnapshot),
				ts: stageSnapshot.startedAt,
			});
			return stageStartEntry;
		};

		const appendStageEndForSnapshot = async (): Promise<void> => {
			if (!input.opts.persistence) return;
			await appendStageEnd(input.opts.persistence, {
				runId: input.runId,
				stageId,
				status: stageSnapshot.status,
				durationMs: stageSnapshot.durationMs,
				endedAt: stageSnapshot.endedAt,
				...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
				...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
				...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
				...(stageSnapshot.failureRecoverability !== undefined
					? { failureRecoverability: stageSnapshot.failureRecoverability }
					: {}),
				...(stageSnapshot.failureDisposition !== undefined
					? { failureDisposition: stageSnapshot.failureDisposition }
					: {}),
				...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
				...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
				...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
				...(stageSnapshot.sessionId !== undefined ? { sessionId: stageSnapshot.sessionId } : {}),
				...(stageSnapshot.sessionFile !== undefined ? { sessionFile: stageSnapshot.sessionFile } : {}),
				...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed"
					? { summary: stageSnapshot.result }
					: {}),
				...stageReplayFields(stageSnapshot),
				...(stageSnapshot.status === "completed" && stageSnapshot.workflowChild !== undefined
					? { workflowChild: stageSnapshot.workflowChild }
					: {}),
			});
		};

		const clearBoundaryChildMetadata = (): void => {
			delete stageSnapshot.workflowChildRun;
			delete stageSnapshot.workflowChild;
		};

		const finalize = (
			status: "completed" | "failed" | "skipped",
			summaryOrError: string,
			workflowChild?: WorkflowChildReplaySnapshot,
			failureError?: unknown,
		): Promise<void> => {
			finalization ??= (async () => {
				await appendStageStartOnce();
				finalized = true;
				unregisterWorkflowExitCleanup();
				stageSnapshot.status = status;
				if (status === "completed") {
					stageSnapshot.result = summaryOrError;
					if (workflowChild !== undefined) stageSnapshot.workflowChild = workflowChild;
				} else if (status === "skipped") {
					clearBoundaryChildMetadata();
					stageSnapshot.skippedReason = summaryOrError;
				} else {
					clearBoundaryChildMetadata();
					applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(failureError));
				}
				if (replayedChild === undefined) {
					stageSnapshot.endedAt = Date.now();
					stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
				}
				input.activeStore.recordStageEnd(input.runId, stageSnapshot);
				input.opts.onStageEnd?.(input.runId, stageSnapshot);
				await appendStageEndForSnapshot();
				input.tracker.onSettle(stageId);
			})();
			return finalization;
		};

		input.activeStore.recordStageStart(input.runId, stageSnapshot);
		input.opts.onStageStart?.(input.runId, stageSnapshot);

		unregisterWorkflowExitCleanup = input.registerWorkflowExitCleanup(stageId, {
			async skipForWorkflowExit(reason?: string): Promise<void> {
				const child = linkedChild;
				if (child !== undefined) requestLinkedChildWorkflowExit(child, reason);
				await finalize("skipped", input.workflowExitSkippedReason(reason));
				if (child !== undefined) await waitForLinkedChildWorkflowExit(child);
			},
		});

		const finalizeReplay = async (): Promise<void> => {
			if (replayedChild === undefined) return;
			finalization ??= (async () => {
				await appendStageStartOnce();
				finalized = true;
				unregisterWorkflowExitCleanup();
				input.activeStore.recordStageEnd(input.runId, stageSnapshot);
				input.opts.onStageEnd?.(input.runId, stageSnapshot);
				await appendStageEndForSnapshot();
				input.tracker.onSettle(stageId);
			})();
			return finalization;
		};

		return {
			id: stageId,
			parentIds: Object.freeze([...parentIds]),
			sourceOrder,
			...(replayedChild !== undefined ? { replayedChild } : {}),
			finalizeReplay,
			async linkChildRun(ref: WorkflowChildRunRef, childController: AbortController): Promise<void> {
				if (finalized) return;
				await appendStageStartOnce();
				linkedChild = { ref: { ...ref }, controller: childController };
				stageSnapshot.workflowChildRun = { ...ref };
				input.activeStore.recordStageWorkflowChildRun(input.runId, stageId, ref);
			},
			observeChildRun(promise: Promise<unknown>): void {
				if (linkedChild === undefined || finalized) return;
				linkedChild.runPromise = promise;
			},
			async complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): Promise<void> {
				await finalize("completed", summary, workflowChild);
			},
			async skipForWorkflowExit(reason?: string): Promise<void> {
				const child = linkedChild;
				if (child !== undefined) requestLinkedChildWorkflowExit(child, reason);
				await finalize("skipped", input.workflowExitSkippedReason(reason));
				if (child !== undefined) await waitForLinkedChildWorkflowExit(child);
			},
			async fail(error: unknown): Promise<void> {
				await finalize("failed", error instanceof Error ? error.message : String(error), undefined, error);
			},
		};
	};
}
