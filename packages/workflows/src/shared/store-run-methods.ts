import { generationAtPause } from "./run-generation.js";
import { isTopLevelWorkflowRun } from "./run-visibility.js";
import {
	applyRunEndMetadata,
	clearRunFailureMetadata,
	clearStaleBlockedRunMetadata,
	type StoreContext,
	TERMINAL_STATUSES,
} from "./store-internal.js";
import type {
	RunBlockedMetadata,
	RunEndMetadata,
	RunPauseMetadata,
	RunResumeMetadata,
	Store,
	StoreInvalidationListener,
} from "./store-public-types.js";
import type {
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	StoreSnapshot,
	WorkflowNotice,
} from "./store-types.js";
import { accumulatePausedDurationMs, elapsedRunMs, elapsedStageMs, nextControlTimestamp } from "./timing.js";
import type { WorkflowOutputValues } from "./types.js";

type RunStoreMethods = Pick<
	Store,
	| "runs"
	| "run"
	| "runPosition"
	| "childRuns"
	| "notices"
	| "activeRunId"
	| "recordRunStart"
	| "editRun"
	| "recordRunSummary"
	| "recordRunExecutionState"
	| "recordRunPool"
	| "recordRunStagePredictions"
	| "reconcileRunParentStage"
	| "recordRunEnd"
	| "recordRunBlocked"
	| "restoreActiveBlockedRun"
	| "removeRun"
	| "recordNotice"
	| "ackNotice"
	| "recordRunPaused"
	| "recordRunResumed"
	| "clear"
	| "snapshot"
	| "graphSnapshot"
	| "inspectionSnapshot"
	| "graphRun"
	| "subscribe"
	| "subscribeInvalidation"
	| "batch"
>;

export function createRunStoreMethods(context: StoreContext): RunStoreMethods {
	const { state } = context;
	let lastFinish = 0;
	const noteFinish = (run: RunSnapshot, previousStatus?: RunStatus, previousSequence?: number): void => {
		// A nested run shares its invocation's route window; replaying it is not a new invocation finish.
		if (!isTopLevelWorkflowRun(run) || !TERMINAL_STATUSES.has(run.status)) {
			delete run.finishSequence;
			return;
		}
		// Imported terminal snapshots keep their recorded order. A live transition advances the clock even if the
		// wall clock stands still or moves backwards; endedAt remains the actual time used to measure duration.
		const endedAt = run.endedAt ?? run.startedAt;
		run.finishSequence ??=
			previousStatus === undefined
				? (context.backend?.getWorkflow(run.id)?.finishSequence ?? endedAt)
				: (previousSequence ?? Math.max(endedAt, lastFinish + 1));
		lastFinish = Math.max(lastFinish, run.finishSequence);
	};

	return {
		runs(): readonly RunSnapshot[] {
			return state.runs;
		},

		run(runId: string): RunSnapshot | undefined {
			return context.findRun(runId);
		},

		runPosition(runId: string): number | undefined {
			return context.runPosition(runId);
		},

		childRuns(parentRunId: string, parentStageId?: string): readonly RunSnapshot[] {
			return context.childRuns(parentRunId, parentStageId);
		},
		notices(): readonly WorkflowNotice[] {
			return state.notices;
		},

		activeRunId(): string | null {
			// Most recently started top-level run that hasn't ended. Nested workflow runs stay in the
			// store for live control/expanded graph rendering, but should not steal the active slot.
			for (let i = state.runs.length - 1; i >= 0; i--) {
				const run = state.runs[i];
				if (run && isTopLevelWorkflowRun(run) && run.endedAt === undefined) {
					return run.id;
				}
			}
			// Degraded fallback: a child run is in flight but no top-level run is.
			for (let i = state.runs.length - 1; i >= 0; i--) {
				const run = state.runs[i];
				if (run && run.endedAt === undefined) {
					return run.id;
				}
			}
			return null;
		},

		recordRunStart(run: RunSnapshot): void {
			// Resume replaces the snapshot, not the identity's prompt answers or notices.
			const previous = context.findRun(run.id);
			noteFinish(run, previous?.status, previous?.finishSequence);
			context.placeRun(run);
			context.bumpAndNotify({ runId: run.id });
		},

		editRun(runId, edit): boolean {
			const run = context.findRun(runId);
			if (run === undefined) return false;
			context.batch(() => {
				const previousStatus = run.status;
				const previousSequence = run.finishSequence;
				const edited = edit(run);
				if (edited.run === true) {
					noteFinish(run, previousStatus, previousSequence);
					context.bumpAndNotify({ runId });
				}
				for (const stageId of edited.stageIds ?? []) context.bumpAndNotify({ runId, stageId });
				for (const toolNodeId of edited.toolNodeIds ?? []) context.bumpAndNotify({ runId, toolNodeId });
			});
			return true;
		},

		recordRunSummary(runId, summary, summarizedThrough): void {
			const run = context.findRun(runId);
			if (!run) return;
			Object.assign(run, { summary, summarizedThrough });
			context.bumpAndNotify();
		},

		recordRunExecutionState(runId, update): void {
			const run = context.findRun(runId);
			if (run === undefined || run.endedAt !== undefined) return;
			if (update.phase !== undefined && update.phase !== run.phase) run.phaseStartedAt = Date.now();
			Object.assign(run, update);
			context.bumpAndNotify({ runId });
		},

		recordRunPool(runId, pool): void {
			const run = context.findRun(runId);
			if (run === undefined) return;
			run.pool = pool;
			context.bumpAndNotify({ runId });
		},

		recordRunStagePredictions(runId, predictions): void {
			const run = context.findRun(runId);
			if (run === undefined) return;
			run.stagePredictions = predictions;
			context.bumpAndNotify({ runId });
		},

		reconcileRunParentStage(runId: string, expectedParentStageId: string, parentStageId: string): boolean {
			const run = context.findRun(runId);
			if (run?.parentStageId !== expectedParentStageId || parentStageId === expectedParentStageId) return false;
			context.reparentRun(run, parentStageId);
			context.bumpAndNotify();
			return true;
		},

		recordRunEnd(
			runId: string,
			status: RunStatus,
			result?: WorkflowOutputValues,
			error?: string,
			metadata?: RunEndMetadata,
		): boolean {
			const run = context.findRun(runId);
			if (!run) return false;
			if (TERMINAL_STATUSES.has(run.status)) return false;
			const endedAt = Date.now();
			const previousStatus = run.status;
			if (metadata?.runGeneration !== undefined) run.runGeneration = metadata.runGeneration;
			else if (status === "blocked" && run.status !== "paused" && run.blockedAt === undefined)
				run.runGeneration = (run.runGeneration ?? 0) + 1;
			run.status = status;
			run.endedAt = endedAt;
			if (metadata?.finishSequence !== undefined) run.finishSequence = metadata.finishSequence;
			noteFinish(run, previousStatus);
			if (run.phase !== undefined) {
				run.phase = "ended";
				run.phaseStartedAt = endedAt;
			}
			if (run.pausedAt !== undefined) {
				run.pausedDurationMs = accumulatePausedDurationMs(run.pausedDurationMs, run.pausedAt, endedAt);
				run.pausedAt = undefined;
			}
			run.durationMs = elapsedRunMs(run, endedAt);
			if (result !== undefined && shouldStoreRunResult(status)) run.result = result;
			const wasBlocked = run.blockedAt !== undefined || run.failureDisposition === "active_blocked";
			delete run.blockedAt;
			if (status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked") {
				clearRunFailureMetadata(run);
				if (status === "blocked" && error !== undefined) run.error = error;
				if (metadata !== undefined) applyRunEndMetadata(run, metadata);
			} else {
				if (wasBlocked && error === undefined) delete run.error;
				if ((status === "failed" || status === "killed") && error !== undefined) {
					run.error = error;
				}
				if (wasBlocked) clearStaleBlockedRunMetadata(run, metadata);
				if (metadata !== undefined) applyRunEndMetadata(run, metadata);
				if (run.failureDisposition === "active_blocked") delete run.failureDisposition;
				if (status === "killed") {
					run.failureRecoverability = "non_recoverable";
					run.failureDisposition = "terminal_killed";
					run.resumable = false;
				}
			}
			const pending = run.pendingPrompt;
			if (pending) {
				context.observation.lifecycle({ kind: "prompt", runId, promptId: pending.id, status: "cancelled" });
				run.pendingPrompt = undefined;
				context.rejectPrompt(pending.id, `atomic-workflows: run ${runId} ended before prompt resolved`);
			}
			context.rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} ended before prompt resolved`);
			context.batch(() => {
				if (status === "killed" || status === "cancelled") endInFlightWork(context, run, status, endedAt, error);
				context.bumpAndNotify({ runId });
			});
			return true;
		},

		recordRunBlocked(runId: string, error: string, metadata: RunBlockedMetadata): boolean {
			const run = context.findRun(runId);
			if (!run) return false;
			if (TERMINAL_STATUSES.has(run.status)) return false;
			if (run.status !== "paused") run.runGeneration = (run.runGeneration ?? 0) + 1;
			run.status = "running";
			run.error = error;
			run.failureKind = metadata.failureKind;
			run.failureCode = metadata.failureCode;
			run.failureRecoverability = metadata.failureRecoverability;
			run.failureDisposition = metadata.failureDisposition;
			run.failureMessage = metadata.failureMessage;
			if (metadata.failedStageId === undefined) delete run.failedStageId;
			else run.failedStageId = metadata.failedStageId;
			run.resumable = metadata.resumable;
			run.blockedAt = metadata.blockedAt ?? Date.now();
			if (metadata.endedAt !== undefined) {
				run.endedAt = metadata.endedAt;
				run.durationMs = elapsedRunMs(run, metadata.endedAt);
			}
			if (metadata.retryAfterMs !== undefined) run.retryAfterMs = metadata.retryAfterMs;
			if (metadata.result !== undefined) run.result = metadata.result;
			if (metadata.budgetState !== undefined) run.budgetState = metadata.budgetState;
			context.bumpAndNotify();
			return true;
		},

		restoreActiveBlockedRun(source: RunSnapshot, error: string, metadata: RunBlockedMetadata): boolean {
			const restored: RunSnapshot = {
				...source,
				status: "running",
				error,
				resumable: metadata.resumable,
				failureRecoverability: metadata.failureRecoverability,
				failureDisposition: metadata.failureDisposition,
				blockedAt: metadata.blockedAt ?? Date.now(),
				stages: source.stages.map((stage) => ({ ...stage })),
				toolNodes: source.toolNodes.map((node) => ({ ...node })),
			};
			delete restored.finishSequence;
			if (metadata.endedAt === undefined) {
				delete restored.endedAt;
				delete restored.durationMs;
			} else {
				restored.endedAt = metadata.endedAt;
				restored.durationMs = elapsedRunMs(restored, metadata.endedAt);
			}
			restored.failureKind = metadata.failureKind;
			restored.failureCode = metadata.failureCode;
			restored.failureMessage = metadata.failureMessage;
			if (metadata.failedStageId === undefined) delete restored.failedStageId;
			else restored.failedStageId = metadata.failedStageId;
			if (metadata.retryAfterMs !== undefined) restored.retryAfterMs = metadata.retryAfterMs;
			if (metadata.result !== undefined) restored.result = metadata.result;
			if (metadata.budgetState !== undefined) restored.budgetState = metadata.budgetState;
			context.placeRun(restored);
			context.bumpAndNotify();
			return true;
		},

		removeRun(runId: string): boolean {
			const index = context.runPosition(runId);
			if (index === undefined) return false;
			const run = state.runs[index]!;
			const pending = run.pendingPrompt;
			if (pending) {
				context.observation.lifecycle({ kind: "prompt", runId, promptId: pending.id, status: "cancelled" });
				context.rejectPrompt(pending.id, `atomic-workflows: run ${runId} was removed before prompt resolved`);
			}
			context.rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} was removed before prompt resolved`);
			for (const stage of run.stages) {
				state.stagePromptAnswers.delete(context.stagePromptAnswerKey(runId, stage.id));
			}
			context.removeRunAt(index);
			for (let i = state.notices.length - 1; i >= 0; i--) {
				if (state.notices[i]?.runId === runId) state.notices.splice(i, 1);
			}
			context.bumpAndNotify();
			return true;
		},

		recordNotice(notice: WorkflowNotice): void {
			state.notices.push(notice);
			context.bumpAndNotify();
		},

		ackNotice(id: string): boolean {
			const notice = state.notices.find((n) => n.id === id);
			if (!notice || notice.ackedAt !== undefined) return false;
			notice.ackedAt = Date.now();
			context.bumpAndNotify();
			return true;
		},

		recordRunPaused(runId: string, pausedAt?: number, metadata?: RunPauseMetadata): boolean {
			const run = context.findRun(runId);
			if (!run) return false;
			if (TERMINAL_STATUSES.has(run.status)) return false;
			const wasPaused = run.status === "paused";
			if (!wasPaused) {
				run.runGeneration = generationAtPause(run);
				run.status = "paused";
				run.pausedAt = nextControlTimestamp(pausedAt, run.resumedAt);
				run.resumedAt = undefined;
				delete run.pauseActor;
				delete run.resumeActor;
				delete run.resumeSource;
			}
			if (metadata?.resumable !== undefined) run.resumable = metadata.resumable;
			if (metadata?.exitReason !== undefined) run.exitReason = metadata.exitReason;
			if (metadata?.exitReason === "quit" && run.quitAt === undefined)
				run.quitAt = nextControlTimestamp(undefined, run.pausedAt);
			// A control path claims the stop it just performed, even when the engine
			// already published the paused state on its way there.
			if (metadata?.actor !== undefined) run.pauseActor = metadata.actor;
			if (wasPaused && metadata === undefined) return false;
			context.bumpAndNotify();
			return true;
		},

		recordRunResumed(runId: string, resumedAt?: number, metadata?: RunResumeMetadata): boolean {
			const run = context.findRun(runId);
			if (!run) return false;
			if (TERMINAL_STATUSES.has(run.status)) return false;
			// Run control is the last step of a resume, by which point stage control
			// or the acknowledgement pass has usually flipped the status already.
			// Recording its attribution anyway is what distinguishes a deliberate
			// resume from the engine continuing work on its own.
			const claimsRunControl = metadata?.source === "run_control";
			if (run.status !== "paused") {
				if (!claimsRunControl || run.status !== "running" || run.resumedAt === undefined) return false;
				if (run.resumeSource === "run_control" && run.resumeActor === metadata?.actor) return false;
				run.resumeSource = "run_control";
				if (metadata?.actor === undefined) delete run.resumeActor;
				else run.resumeActor = metadata.actor;
				context.bumpAndNotify();
				return false;
			}
			const resumedTs = nextControlTimestamp(resumedAt, run.pausedAt);
			run.status = "running";
			run.pausedDurationMs = accumulatePausedDurationMs(run.pausedDurationMs, run.pausedAt, resumedTs);
			run.resumedAt = resumedTs;
			run.pausedAt = undefined;
			delete run.quitAt;
			delete run.exitReason;
			delete run.pauseActor;
			if (metadata === undefined) {
				delete run.resumeActor;
				delete run.resumeSource;
			} else {
				run.resumeSource = metadata.source;
				if (metadata.actor === undefined) delete run.resumeActor;
				else run.resumeActor = metadata.actor;
			}
			context.bumpAndNotify();
			return true;
		},

		clear(): void {
			if (
				state.runs.length === 0 &&
				state.notices.length === 0 &&
				state.resolvers.size === 0 &&
				state.stagePromptAnswers.size === 0 &&
				state.stagePromptDrafts.size === 0
			)
				return;
			context.clearRuns();
			state.notices.length = 0;
			for (const entry of state.resolvers.values()) {
				entry.reject(new Error("atomic-workflows: store cleared"));
			}
			state.resolvers.clear();
			state.stagePromptAnswers.clear();
			state.stagePromptDrafts.clear();
			context.bumpAndNotify();
		},

		snapshot(): StoreSnapshot {
			return context.snapshot();
		},

		graphSnapshot(): StoreSnapshot {
			return context.graphSnapshot();
		},

		inspectionSnapshot(runId?: string): StoreSnapshot {
			return context.inspectionSnapshot(runId);
		},

		graphRun(runId: string): RunSnapshot | undefined {
			return context.graphRun(runId);
		},

		subscribe(fn: (snap: StoreSnapshot) => void): () => void {
			state.listeners.add(fn);
			return () => {
				state.listeners.delete(fn);
			};
		},

		subscribeInvalidation(fn: StoreInvalidationListener): () => void {
			state.invalidationListeners.add(fn);
			return () => state.invalidationListeners.delete(fn);
		},

		batch<T>(update: () => T): T {
			return context.batch(update);
		},
	};
}

// A paused stage keeps showing that it was paused when its run ends (#2891).
const IN_FLIGHT_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["running", "awaiting_input", "suspended"]);

/**
 * Ends the work a killed or cancelled run still had in flight (#4875): its stages fail as killed or skip as
 * cancelled, and its running tool calls are cancelled, so no surface shows a stopped run as still working. Finished,
 * blocked, paused and never-started stages keep their state, and so does a workflow boundary: a nested child run
 * ends its own work, and its boundary, when it ends.
 */
function endInFlightWork(
	context: StoreContext,
	run: RunSnapshot,
	status: "killed" | "cancelled",
	endedAt: number,
	error?: string,
): void {
	for (const stage of run.stages) {
		// A workflow boundary stays linked to its child run, which ends it when the child itself ends.
		if (!IN_FLIGHT_STAGE_STATUSES.has(stage.status) || stage.workflowChildRun !== undefined) continue;
		if (status === "killed") {
			const message = error ?? "workflow killed";
			Object.assign(stage, {
				status: "failed",
				error: message,
				failureKind: "cancelled",
				failureCode: "cancelled",
				failureRecoverability: "non_recoverable",
				failureDisposition: "terminal_killed",
				failureMessage: message,
			} satisfies Partial<StageSnapshot>);
		} else {
			stage.status = "skipped";
			stage.skippedReason = run.exitReason ?? "cancelled";
		}
		if (stage.endedAt === undefined) {
			stage.endedAt = endedAt;
			stage.durationMs = elapsedStageMs(stage, endedAt);
		}
		delete stage.awaitingInputSince;
		delete stage.inputRequest;
		delete stage.wait;
		context.bumpAndNotify({ runId: run.id, stageId: stage.id });
	}
	for (const node of run.toolNodes) {
		if (node.status !== "running" && node.status !== "pending") continue;
		node.status = "cancelled";
		node.endedAt = endedAt;
		if (node.startedAt !== undefined) node.durationMs = Math.max(0, endedAt - node.startedAt);
		context.bumpAndNotify({ runId: run.id, toolNodeId: node.id });
	}
}

function shouldStoreRunResult(status: RunStatus): boolean {
	return (
		status === "completed" ||
		status === "skipped" ||
		status === "cancelled" ||
		status === "blocked" ||
		status === "failed"
	);
}
