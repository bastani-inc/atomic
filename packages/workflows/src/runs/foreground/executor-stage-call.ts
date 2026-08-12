import { rebasedStageStartedAt } from "../../shared/timing.js";
import type { StageOptions } from "../../shared/types.js";
import type { ConcurrencyLimiter } from "../shared/concurrency.js";
import { raceAbort } from "./executor-abort.js";
import { hasExplicitFastModeCandidate } from "./executor-direct-helpers.js";
import {
	askReadinessViaStageBroker,
	RESUME_CONTINUATION_PROMPT,
	shouldInjectResumeContinuation,
} from "./executor-hil.js";
import { applyFailureToStage } from "./executor-lifecycle.js";
import { isTerminalStage } from "./executor-scheduler.js";
import type { LiveStageRuntime } from "./executor-stage-types.js";
import type { StageAdapters } from "./stage-runner.js";

export interface TrackedStageCallOptions {
	readonly eagerSession?: boolean;
	readonly allowFinalized?: boolean;
}

export type TrackedStageCaller = <T>(
	call: () => Promise<T>,
	eagerSessionOrOptions?: boolean | TrackedStageCallOptions,
) => Promise<T>;

function normalizeTrackedStageCallOptions(
	input: boolean | TrackedStageCallOptions | undefined,
): Required<TrackedStageCallOptions> {
	if (typeof input === "boolean") return { eagerSession: input, allowFinalized: false };
	return { eagerSession: input?.eagerSession === true, allowFinalized: input?.allowFinalized === true };
}

function throwFinalizationError(error: unknown): never {
	throw error;
}

export function createTrackedStageCaller(input: {
	readonly runtime: LiveStageRuntime;
	readonly limiter: ConcurrencyLimiter;
	readonly options: StageOptions | undefined;
	readonly adapters: StageAdapters;
	readonly hasContinuation: boolean;
	readonly hasScopedParents: boolean;
}): TrackedStageCaller {
	const { runtime } = input;
	const readinessGateEnabled =
		runtime.opts.confirmStageReadiness !== undefined || runtime.opts.usePromptNodesForUi === true;
	const confirmReadiness = async (): Promise<"advance" | "stay"> => {
		try {
			if (runtime.opts.confirmStageReadiness !== undefined) {
				const ready = await runtime.opts.confirmStageReadiness({
					runId: runtime.runId,
					stageId: runtime.stageId,
					stageName: runtime.name,
					signal: runtime.signal,
				});
				return ready ? "advance" : "stay";
			}
			return await askReadinessViaStageBroker(runtime.runId, runtime.stageId, runtime.signal);
		} catch {
			return "advance";
		}
	};

	const suppressReadinessForCurrentTurn = (): void => {
		runtime.state.askUserQuestionObservedThisTurn = false;
		runtime.state.chatAnswerObservedThisTurn = false;
	};

	const skipResumeContinuationInjection = (): boolean => {
		if (runtime.state.stageFinalized) return true;
		if (runtime.state.skippedForParallelFailFast) return true;
		if (runtime.stageSnapshot.status === "skipped" && runtime.stageSnapshot.skippedReason === "fail-fast")
			return true;
		if (isTerminalStage(runtime.stageSnapshot)) return true;
		if (runtime.stageFailFastScope?.failed === true && runtime.stageFailFastScope.activeStages.has(runtime.stageId))
			return true;
		if (runtime.innerCtx.__structuredOutputFinalized()) return true;
		return false;
	};

	const drainResumeContinuations = async <T>(
		currentResult: T,
	): Promise<{
		readonly result: T;
		readonly chatAnswerObserved: boolean;
	}> => {
		let result = currentResult;
		let chatAnswerObserved = runtime.state.chatAnswerObservedThisTurn;
		const captureChatAnswer = (): void => {
			chatAnswerObserved ||= runtime.state.chatAnswerObservedThisTurn;
		};
		while (runtime.state.resumeContinuationPending !== false) {
			const reason = runtime.state.resumeContinuationPending;
			runtime.state.resumeContinuationPending = false;
			captureChatAnswer();
			suppressReadinessForCurrentTurn();
			if (
				!shouldInjectResumeContinuation({
					reason,
					gateEnabled: readinessGateEnabled,
					aborted: runtime.signal.aborted,
				}) ||
				skipResumeContinuationInjection()
			)
				continue;
			const suppressQueuedContinuation = reason === "paused-queued-user-message";
			if (suppressQueuedContinuation) runtime.state.suppressQueuedUserMessageContinuation = true;
			try {
				result = (await runtime.raceStageSessionHeartbeat(
					raceAbort(runtime.innerCtx.prompt(RESUME_CONTINUATION_PROMPT), runtime.signal),
				)) as T;
			} finally {
				if (suppressQueuedContinuation) runtime.state.suppressQueuedUserMessageContinuation = false;
			}
			captureChatAnswer();
		}
		captureChatAnswer();
		return { result, chatAnswerObserved };
	};

	return async <T>(call: () => Promise<T>, eagerSessionOrOptions?: boolean | TrackedStageCallOptions): Promise<T> => {
		const callOptions = normalizeTrackedStageCallOptions(eagerSessionOrOptions);
		runtime.exit.throwIfWorkflowExitSelected();
		await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
		if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();

		await input.limiter.acquire();
		try {
			await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
			runtime.exit.throwIfWorkflowExitSelected();
			if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();
		} catch (err) {
			input.limiter.release();
			throw err;
		}

		const trackStageLifecycle = !runtime.state.stageFinalized;
		let applyTerminalStageState: (() => void) | undefined;
		// Set only alongside the successful "completed" terminal state, so a failed
		// final durable checkpoint can replace it without touching a real
		// failure/skip classification recorded by the catch block.
		let terminalStateIsSuccess = false;
		try {
			let refreshedParentIds: readonly string[] | undefined;
			if (
				trackStageLifecycle &&
				!input.hasContinuation &&
				runtime.stageSnapshot.startedAt === undefined &&
				!input.hasScopedParents
			) {
				const actualParentIds = runtime.scheduler.tracker.currentParents();
				const sameParents =
					actualParentIds.length === runtime.stageSnapshot.parentIds.length &&
					actualParentIds.every((value) => runtime.stageSnapshot.parentIds.includes(value));
				if (!sameParents) {
					runtime.scheduler.tracker.replaceParents(runtime.stageId, actualParentIds);
					refreshedParentIds = actualParentIds;
				}
			}
			if (trackStageLifecycle) {
				const now = Date.now();
				const hasNoExplicitModelConfig =
					input.options?.model === undefined && input.options?.fallbackModels === undefined;
				const promptAdapterHandlesInitialPrompt = input.adapters.prompt !== undefined;
				if (
					callOptions.eagerSession &&
					!promptAdapterHandlesInitialPrompt &&
					(hasNoExplicitModelConfig ||
						(await hasExplicitFastModeCandidate({
							model: input.options?.model,
							fallbackModels: input.options?.fallbackModels,
							models: runtime.opts.models,
						})))
				) {
					try {
						await runtime.innerCtx.__ensureSession();
					} catch (err) {
						if (!(err instanceof Error && err.message.includes("prompt adapter not configured"))) throw err;
					}
				}
				if (refreshedParentIds !== undefined) {
					runtime.scheduler.setStageParentIds(runtime.stageSnapshot, refreshedParentIds);
				}
				runtime.stageSnapshot.status = "running";
				runtime.stageSnapshot.startedAt ??= rebasedStageStartedAt(input.options?.durableAccumulatedDurationMs, now);
				runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
				// Publish every graph-visible live write before this task can yield.
				runtime.activeStore.recordStageStart(runtime.runId, runtime.stageSnapshot);
				runtime.appendStageStartOnce();
				const sessionMeta = runtime.innerCtx.__sessionMeta();
				if (sessionMeta.sessionId !== undefined || sessionMeta.sessionFile !== undefined) {
					await runtime.captureStageSessionMeta({ awaitDurable: true });
				}
				runtime.startStageSessionHeartbeat();
			} else {
				runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
			}

			runtime.mcpScope.apply();

			const abortSession = (): void => {
				void runtime.innerCtx.abort().catch(() => {});
			};
			if (runtime.signal.aborted) abortSession();
			else runtime.signal.addEventListener("abort", abortSession, { once: true });
			let result: T;
			try {
				runtime.state.askUserQuestionObservedThisTurn = false;
				runtime.state.chatAnswerObservedThisTurn = false;
				result = await runtime.raceStageSessionHeartbeat(raceAbort(call(), runtime.signal));
				const initialDrain = await drainResumeContinuations(result);
				result = initialDrain.result;
				let repeatReadinessAfterChatTurn = initialDrain.chatAnswerObserved;

				if (
					!runtime.signal.aborted &&
					readinessGateEnabled &&
					(runtime.state.askUserQuestionObservedThisTurn || repeatReadinessAfterChatTurn) &&
					!runtime.innerCtx.__structuredOutputFinalized()
				) {
					let resolveNextTurnEnd: (() => void) | null = null;
					const unsubscribeTurnWatcher = runtime.innerCtx.subscribe((event) => {
						if ((event as { type?: unknown }).type === "agent_end" && resolveNextTurnEnd) {
							const resolve = resolveNextTurnEnd;
							resolveNextTurnEnd = null;
							resolve();
						}
					});
					try {
						while (runtime.state.askUserQuestionObservedThisTurn || repeatReadinessAfterChatTurn) {
							const decision = await confirmReadiness();
							if (decision === "advance") break;
							if (runtime.signal.aborted) break;
							runtime.state.askUserQuestionObservedThisTurn = false;
							runtime.state.chatAnswerObservedThisTurn = false;
							runtime.state.waitingForStageChatTurn = true;
							try {
								await runtime.raceStageSessionHeartbeat(
									raceAbort(
										new Promise<void>((resolve) => {
											resolveNextTurnEnd = resolve;
											runtime.state.wakeWaitingForStageChatTurn = resolve;
										}),
										runtime.signal,
									),
								);
							} finally {
								runtime.state.wakeWaitingForStageChatTurn = undefined;
								runtime.state.waitingForStageChatTurn = false;
							}
							if (runtime.signal.aborted) break;
							result = (runtime.innerCtx.__getLastAssistantText() ?? result) as T;
							const continuationDrain = await drainResumeContinuations(result);
							result = continuationDrain.result;
							repeatReadinessAfterChatTurn ||= continuationDrain.chatAnswerObserved;
							if (runtime.innerCtx.__structuredOutputFinalized()) break;
						}
					} finally {
						runtime.state.wakeWaitingForStageChatTurn = undefined;
						resolveNextTurnEnd = null;
						unsubscribeTurnWatcher();
					}
				}
			} finally {
				runtime.signal.removeEventListener("abort", abortSession);
			}
			await runtime.innerCtx.__closeGeneration();
			await runtime.captureStageSessionMeta({ awaitDurable: true });
			runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
			if (
				trackStageLifecycle &&
				runtime.stageFailFastScope?.failed === true &&
				runtime.stageFailFastScope.activeStages.has(runtime.stageId)
			) {
				runtime.markSkippedForParallelFailFast();
				throw runtime.parallelFailFastError();
			}
			if (trackStageLifecycle && runtime.state.stageFinalized) throw runtime.parallelFailFastError();
			if (trackStageLifecycle) {
				const assistantText = runtime.innerCtx.__getLastAssistantText();
				terminalStateIsSuccess = true;
				applyTerminalStageState = () => {
					runtime.stageSnapshot.status = "completed";
					if (assistantText !== undefined) runtime.stageSnapshot.result = assistantText;
				};
			}
			return result;
		} catch (err) {
			const workflowExitAbort = runtime.signal.aborted ? runtime.exit.currentWorkflowExitAbortReason() : undefined;
			if (workflowExitAbort !== undefined && !runtime.state.skippedForParallelFailFast) {
				runtime.state.stageClosedByWorkflowExit = true;
				if (trackStageLifecycle && !isTerminalStage(runtime.stageSnapshot)) {
					const skippedReason = runtime.exit.workflowExitSkippedReason(workflowExitAbort.reason);
					applyTerminalStageState = () => {
						runtime.stageSnapshot.status = "skipped";
						runtime.stageSnapshot.skippedReason = skippedReason;
					};
				}
			} else if (trackStageLifecycle && !runtime.signal.aborted && !runtime.state.skippedForParallelFailFast) {
				const failure = runtime.classifyExecutorFailure(err);
				applyTerminalStageState = () => applyFailureToStage(runtime.stageSnapshot, failure);
			}
			throw err;
		} finally {
			// Finalization, handle release, and limiter release are each independent.
			// If finalizeStageSnapshot() throws, the limiter must still be released
			// so the concurrency semaphore is not leaked.
			// cross-ref: issue #1498 — durable finalization failures must not leak the stage limiter.
			let finalizationError: { readonly thrown: true; readonly error: unknown } | undefined;
			// Tracked separately from `finalizationError`: only a failed final durable
			// checkpoint may rewrite an otherwise-successful terminal stage state.
			let durableCheckpointError: { readonly thrown: true; readonly error: unknown } | undefined;
			try {
				runtime.mcpScope.clear();
			} catch (err) {
				finalizationError = { thrown: true, error: err };
			}
			try {
				// Drain rather than stop: a checkpoint still in flight must be awaited
				// here, or its late rejection is discarded with the cancelled timer.
				await runtime.drainStageSessionHeartbeat();
			} catch (err) {
				durableCheckpointError = { thrown: true, error: err };
			}
			try {
				await runtime.innerCtx.__closeGeneration();
				await runtime.captureStageSessionMeta({ awaitDurable: true });
			} catch (err) {
				durableCheckpointError ??= { thrown: true, error: err };
			}
			finalizationError ??= durableCheckpointError;
			if (trackStageLifecycle) {
				// A stage whose final durability checkpoint failed must never be
				// persisted as `completed` while its caller receives that rejection.
				if (durableCheckpointError !== undefined && terminalStateIsSuccess) {
					const failure = runtime.classifyExecutorFailure(durableCheckpointError.error);
					applyTerminalStageState = () => applyFailureToStage(runtime.stageSnapshot, failure);
				}
				if (!runtime.state.stageFinalized) applyTerminalStageState?.();
				// `finalizeStageSnapshot` calls the version-bumping `recordStageEnd`
				// before its first yield, so the live write cannot outpace the cache.
				try {
					await runtime.finalizeStageSnapshot();
				} catch (err) {
					finalizationError ??= { thrown: true, error: err };
				}
				try {
					if (
						runtime.state.stageClosedByWorkflowExit ||
						runtime.exit.currentWorkflowExitAbortReason() !== undefined
					) {
						await runtime.releaseLiveHandle().catch(() => {});
					} else {
						await runtime.dropStageControlForCompletion().catch(() => {});
					}
				} catch {
					// Best-effort: handle release failure must not prevent limiter release.
				}
			} else if (
				runtime.state.stageClosedByWorkflowExit ||
				runtime.exit.currentWorkflowExitAbortReason() !== undefined
			) {
				await runtime.releaseLiveHandle().catch(() => {});
			}
			input.limiter.release();
			if (finalizationError !== undefined) throwFinalizationError(finalizationError.error);
		}
	};
}
