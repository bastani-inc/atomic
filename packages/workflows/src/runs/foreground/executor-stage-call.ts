import { BUDGET_WRAP_UP_PROMPT, WorkflowBudgetExceededError } from "../../engine/run-budget.js";
import { rebasedStageStartedAt } from "../../shared/timing.js";
import type {
	StageOptions,
	WorkflowMaxOutput,
	WorkflowModelUsage,
	WorkflowSerializableValue,
} from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { ConcurrencyLimiter } from "../shared/concurrency.js";
import { closeBlockedStageForGoodWhenRunEnds } from "./blocked-stage-close.js";
import { raceAbort, WORKFLOW_KILLED_ABORT_REASON } from "./executor-abort.js";
import {
	askReadinessViaStageBroker,
	READINESS_GATE_CHAT_MESSAGE,
	RESUME_CONTINUATION_PROMPT,
	type ReadinessDecision,
	shouldInjectResumeContinuation,
	userMessageText,
} from "./executor-hil.js";
import { applyFailureToStage } from "./executor-lifecycle.js";
import { isTerminalStage } from "./executor-scheduler.js";
import type { LiveStageRuntime } from "./executor-stage-types.js";
import { structuredTaskOutputText, truncateTaskOutput } from "./executor-task-prompts.js";
import {
	decisionModelGivesNoProbabilities,
	describeReadinessDecision,
	READINESS_DECISION_INSTRUCTIONS,
	READINESS_DECISION_QUESTIONS,
	readinessDecisionRecord,
	readinessFailureRecord,
	readinessState,
	readinessVerdict,
	type StageReadinessDecision,
} from "./readiness-decision.js";
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

/** How often readiness checks whether the turn a newer user message started has ended. */
const STAGE_TURN_POLL_MS = 50;

/** The stage's objective: the text of its first user message, which is the stage prompt. */
function stageObjective(messages: readonly object[]): string | undefined {
	const first = messages.find((message) => (message as { readonly role?: unknown }).role === "user");
	return first === undefined ? undefined : userMessageText((first as { readonly content?: unknown }).content);
}

function recordReadinessDecision(runtime: LiveStageRuntime, decision: StageReadinessDecision): void {
	runtime.stageSnapshot.readinessDecision = decision;
	runtime.activeStore.recordStageNotice(runtime.runId, runtime.stageId, {
		id: crypto.randomUUID(),
		ts: decision.at,
		kind: "decision",
		to: decision.outcome,
		...(decision.model === undefined ? {} : { from: decision.model }),
		meta: describeReadinessDecision(decision),
	});
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
	const confirmReadiness = async (signal: AbortSignal): Promise<ReadinessDecision> => {
		if (runtime.opts.confirmStageReadiness !== undefined) {
			const ready = await raceAbort(
				runtime.opts.confirmStageReadiness({
					runId: runtime.runId,
					stageId: runtime.stageId,
					stageName: runtime.name,
					signal,
				}),
				signal,
			);
			return ready ? { action: "advance" } : { action: "stay" };
		}
		return await askReadinessViaStageBroker(runtime.runId, runtime.stageId, signal, runtime.stageUiBroker);
	};
	/**
	 * Readiness after a steer: the decision model advances the stage or keeps it open without asking. An uncertain or
	 * failed decision returns `undefined`, and the user is asked as before. `superseded`: the user sent another message
	 * while the decision model answered, so its verdict is discarded unrecorded. A pause or abort rejects, keeping the
	 * user's message for the next attempt.
	 */
	const decideReadiness = async (signal: AbortSignal): Promise<ReadinessDecision | "superseded" | undefined> => {
		const models = runtime.opts.models;
		const userMessage = runtime.state.latestUserMessage;
		if (models?.decide === undefined || userMessage === undefined || models.autoAdvanceAfterSteer?.() === false)
			return undefined;
		const messageSeq = runtime.state.userMessageSeq;
		let decision: StageReadinessDecision | undefined;
		try {
			const result = await models.decide({
				state: readinessState({
					objective: stageObjective(runtime.innerCtx.messages),
					userMessage,
					reply: runtime.innerCtx.__getLastAssistantText(),
				}),
				questions: READINESS_DECISION_QUESTIONS,
				instructions: READINESS_DECISION_INSTRUCTIONS,
				requireProbabilities: true,
				signal,
			});
			decision = readinessDecisionRecord(readinessVerdict(result), result.model);
		} catch (error) {
			if (signal.aborted) throw error;
			decision = decisionModelGivesNoProbabilities(error) ? undefined : readinessFailureRecord(error);
		}
		if (runtime.state.userMessageSeq !== messageSeq) return "superseded";
		runtime.state.latestUserMessage = undefined;
		if (decision === undefined) return undefined;
		recordReadinessDecision(runtime, decision);
		if (decision.outcome === "advanced") return { action: "advance" };
		if (decision.outcome === "stayed") return { action: "stay" };
		return undefined;
	};

	/** Waits while the stage's session runs or admits a turn, such as the one a newer user message started. */
	const waitForNewerUserTurn = async (): Promise<void> => {
		while (runtime.innerCtx.isStreaming || runtime.innerCtx.__turnLoopBusy?.() === true)
			await runtime.raceStageSessionHeartbeat(
				raceAbort(new Promise<void>((resolve) => setTimeout(resolve, STAGE_TURN_POLL_MS)), runtime.signal),
			);
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
					runtime.abortListeners.race(runtime.innerCtx.__continuePrompt(RESUME_CONTINUATION_PROMPT)),
				)) as T;
			} finally {
				if (suppressQueuedContinuation) runtime.state.suppressQueuedUserMessageContinuation = false;
			}
			captureChatAnswer();
		}
		captureChatAnswer();
		return { result, chatAnswerObserved };
	};
	const deliverBudgetWrapUp = async (): Promise<never> => {
		let summary: string | undefined;
		let usage: WorkflowModelUsage | undefined;
		try {
			const response = await runtime.raceStageSessionHeartbeat(
				runtime.abortListeners.race(runtime.innerCtx.prompt(BUDGET_WRAP_UP_PROMPT)),
			);
			summary = typeof response === "string" ? response : runtime.innerCtx.__getLastAssistantText();
			usage = runtime.innerCtx.__modelFallbackMeta().modelAttempts?.at(-1)?.usage;
		} catch {
			// A failed or aborted wrap-up did not deliver a summary and must not
			// consume the once-per-run delivery allowance.
		}
		throw runtime.budget.finishWrapUp(runtime.name, summary, usage, summary !== undefined);
	};

	let slotUsers = 0;
	let slotAcquisition: Promise<void> | undefined;
	const holdSlot = async (): Promise<void> => {
		slotUsers += 1;
		try {
			if (slotAcquisition === undefined && runtime.state.limiterSlot !== "none") return;
			slotAcquisition ??= input.limiter.acquire().then(
				() => {
					runtime.state.limiterSlot = "held";
					slotAcquisition = undefined;
				},
				(error: Error) => {
					slotAcquisition = undefined;
					throw error;
				},
			);
			await slotAcquisition;
		} catch (error) {
			slotUsers -= 1;
			throw error;
		}
	};
	const letGoSlot = (): void => {
		slotUsers -= 1;
		if (slotUsers > 0) return;
		if (runtime.state.limiterSlot === "held") input.limiter.release();
		runtime.state.limiterSlot = "none";
	};
	/** Calls still running that track the stage's lifecycle: the last of them to finish ends the stage (#4450). */
	let lifecycleUsers = 0;
	/** Set once the last of them starts ending the stage; a call that starts later runs as after the stage ended. */
	let stageEnding = false;
	/** The first failure among those calls that left the stage to a peer, recorded by the call that ends it. */
	let overlapFailure: { readonly apply: () => void; readonly blockedResumably: boolean } | undefined;

	const runTrackedCall = async <T>(
		call: () => Promise<T>,
		eagerSessionOrOptions?: boolean | TrackedStageCallOptions,
	): Promise<T> => {
		const callOptions = normalizeTrackedStageCallOptions(eagerSessionOrOptions);
		runtime.exit.throwIfWorkflowExitSelected();
		if (runtime.budget.enabled) await runtime.budget.stopAtBoundaryAsync(runtime.name);
		await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
		if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();

		await holdSlot();
		try {
			await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
			runtime.exit.throwIfWorkflowExitSelected();
			if (runtime.state.stageFinalized && !callOptions.allowFinalized) throw runtime.parallelFailFastError();
		} catch (err) {
			letGoSlot();
			throw err;
		}

		const trackStageLifecycle = !runtime.state.stageFinalized && !stageEnding;
		runtime.state.sessionCheckpointed = false;
		let applyTerminalStageState: (() => void) | undefined;
		// Set only alongside the successful "completed" terminal state, so a failed
		// final durable checkpoint can replace it without touching a real
		// failure/skip classification recorded by the catch block.
		let terminalStateIsSuccess = false;
		let stageResultBeforeBudget: string | undefined;
		// A recoverable failure blocks the stage resumably (the run stays `active_blocked`): its subagent children stay
		// resumable with it, rather than ending as for a stage that closed for good.
		let blockedResumably = false;
		// This call's own classified failure, published for the run when a peer call still runs (#4450).
		let stageFailure: WorkflowFailure | undefined;
		const unregisterBudgetWrapUp = runtime.budget.registerWrapUp(runtime.name, deliverBudgetWrapUp);
		if (trackStageLifecycle) lifecycleUsers += 1;
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
				if (callOptions.eagerSession && !promptAdapterHandlesInitialPrompt && hasNoExplicitModelConfig) {
					try {
						await runtime.innerCtx.__ensureSession();
					} catch (err) {
						if (!(err instanceof Error && err.message.includes("prompt adapter not configured"))) throw err;
					}
				}
				if (refreshedParentIds !== undefined) {
					runtime.scheduler.setStageParentIds(runtime.stageSnapshot, refreshedParentIds);
				}
				if (!runtime.innerCtx.__isPaused()) runtime.stageSnapshot.status = "running";
				runtime.stageSnapshot.startedAt ??= rebasedStageStartedAt(input.options?.durableAccumulatedDurationMs, now);
				runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
				// Publish every graph-visible live write before this task can yield.
				runtime.activeStore.recordStageStart(runtime.runId, runtime.stageSnapshot);
				await runtime.appendStageStartOnce();
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
			const removeAbortSession = runtime.abortListeners.add(abortSession);
			let result: T;
			try {
				runtime.state.askUserQuestionObservedThisTurn = false;
				runtime.state.chatAnswerObservedThisTurn = false;
				result = await runtime.raceStageSessionHeartbeat(runtime.abortListeners.race(call()));
				if (runtime.budget.enabled && typeof result === "string") stageResultBeforeBudget = result;
				const initialDrain = await drainResumeContinuations(result);
				result = initialDrain.result;
				if (runtime.budget.enabled && typeof result === "string") stageResultBeforeBudget = result;
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
							runtime.signal.throwIfAborted();
							if (runtime.stageSnapshot.status === "paused" || runtime.stageSnapshot.status === "blocked") {
								await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
								continue;
							}
							const controller = new AbortController();
							runtime.state.readinessController = controller;
							let decision: ReadinessDecision;
							let superseded: boolean;
							try {
								const readinessSignal = AbortSignal.any([runtime.signal, controller.signal]);
								const decided = await decideReadiness(readinessSignal);
								superseded = decided === "superseded";
								decision =
									decided === "superseded"
										? { action: "stay" }
										: (decided ?? (await runtime.awaitPromptAnswer(confirmReadiness(readinessSignal))));
								// An answer can win its promise race while pause still wins admission.
								if (decision.action === "advance" || decision.message !== undefined) {
									await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
								}
								runtime.signal.throwIfAborted();
								if (controller.signal.aborted) {
									await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
									continue;
								}
							} catch (error) {
								runtime.signal.throwIfAborted();
								if (controller.signal.aborted) {
									await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
									continue;
								}
								throw error;
							}
							if (decision.action === "advance") break;
							delete runtime.state.readinessController;
							if (runtime.signal.aborted) break;
							runtime.state.askUserQuestionObservedThisTurn = false;
							runtime.state.chatAnswerObservedThisTurn = false;
							if (superseded) {
								await waitForNewerUserTurn();
								result = (runtime.innerCtx.__getLastAssistantText() ?? result) as T;
								repeatReadinessAfterChatTurn = true;
							} else if (decision.message !== undefined) {
								// Text typed into the readiness question is the user's message; "chat more" is not.
								if (decision.message !== READINESS_GATE_CHAT_MESSAGE)
									runtime.state.latestUserMessage = decision.message;
								result = (await runtime.raceStageSessionHeartbeat(
									runtime.abortListeners.race(runtime.innerCtx.__continuePrompt(decision.message)),
								)) as T;
								if (runtime.budget.enabled && typeof result === "string") stageResultBeforeBudget = result;
							} else {
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
								const responseText = runtime.innerCtx.__getLastAssistantText();
								if (responseText !== undefined) {
									result = responseText as T;
									if (runtime.budget.enabled) stageResultBeforeBudget = responseText;
								}
							}
							const continuationDrain = await drainResumeContinuations(result);
							result = continuationDrain.result;
							if (runtime.budget.enabled && typeof result === "string") stageResultBeforeBudget = result;
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
				removeAbortSession();
			}
			// A generation closed under the running stage refused every tool call after it: the stage
			// cannot have done its work, so it fails rather than completing (#3996).
			if (runtime.innerCtx.__generationClosedUnderStage?.() === true)
				throw new Error(
					`atomic-workflows: stage "${runtime.name}" generation closed before the stage finished; its tool calls were refused`,
				);
			if (runtime.budget.enabled) stageResultBeforeBudget ??= runtime.innerCtx.__getLastAssistantText();
			runtime.applyModelFallbackMeta(runtime.innerCtx.__modelFallbackMeta());
			const afterBudget = runtime.budget.checkpoint(runtime.name);
			if (afterBudget.kind === "wrap_up") await runtime.budget.deliverWrapUp(runtime.name);
			if (afterBudget.kind === "exhausted" && runtime.budget.enabled)
				await runtime.budget.stopAtBoundaryAsync(runtime.name);
			const peersStillRunning = trackStageLifecycle && lifecycleUsers > 1;
			if (trackStageLifecycle && !peersStillRunning) stageEnding = true;
			// A peer's recoverable failure blocks the stage resumably, so its generation stays open for a resume.
			const closedForGood = !(trackStageLifecycle && overlapFailure?.blockedResumably === true);
			const finalizedArtifact = peersStillRunning
				? undefined
				: await runtime.innerCtx.__closeGeneration(closedForGood);
			if (typeof result === "string" && finalizedArtifact !== undefined) result = finalizedArtifact as T;
			await runtime.captureStageSessionMeta({ awaitDurable: true });
			if (
				trackStageLifecycle &&
				runtime.stageFailFastScope?.failed === true &&
				runtime.stageFailFastScope.activeStages.has(runtime.stageId)
			) {
				runtime.markSkippedForParallelFailFast();
				throw runtime.parallelFailFastError();
			}
			if (trackStageLifecycle && runtime.state.skippedForParallelFailFast) throw runtime.parallelFailFastError();
			if (runtime.state.stageClosedByWorkflowExit) throw runtime.signal.reason;
			if (trackStageLifecycle) {
				const assistantText = runtime.budget.enabled
					? (stageResultBeforeBudget ?? runtime.innerCtx.__getLastAssistantText())
					: runtime.innerCtx.__getLastAssistantText();
				terminalStateIsSuccess = true;
				const structuredOutput = typeof result === "string" ? undefined : (result as WorkflowSerializableValue);
				const maxOutput = (input.options as { readonly maxOutput?: WorkflowMaxOutput } | undefined)?.maxOutput;
				const rawText =
					typeof result === "string"
						? result
						: (assistantText ??
							(structuredOutput === undefined ? undefined : structuredTaskOutputText(structuredOutput)));
				const text = rawText === undefined ? undefined : truncateTaskOutput(rawText, maxOutput);
				applyTerminalStageState = () => {
					runtime.stageSnapshot.status = "completed";
					if (text !== undefined) runtime.stageSnapshot.result = text;
					if (typeof result !== "string") runtime.stageSnapshot.structured = structuredOutput;
				};
			}
			return result;
		} catch (err) {
			const workflowExitAbort = runtime.signal.aborted ? runtime.exit.currentWorkflowExitAbortReason() : undefined;
			const budgetError = err instanceof WorkflowBudgetExceededError ? err : undefined;
			if (budgetError !== undefined && trackStageLifecycle && !runtime.state.skippedForParallelFailFast) {
				let selectedBudgetError = budgetError;
				if (runtime.activeStore.run(runtime.runId)?.budgetState?.wrapUpCompleted !== true) {
					try {
						await runtime.budget.deliverWrapUp(runtime.name);
					} catch (wrapUpError) {
						if (wrapUpError instanceof WorkflowBudgetExceededError) selectedBudgetError = wrapUpError;
					}
				}
				applyTerminalStageState = () => {
					if (stageResultBeforeBudget !== undefined) {
						runtime.stageSnapshot.status = "completed";
						runtime.stageSnapshot.result = stageResultBeforeBudget;
					} else {
						runtime.stageSnapshot.status = "failed";
						runtime.stageSnapshot.error = selectedBudgetError.message;
					}
				};
				throw selectedBudgetError;
			} else if (workflowExitAbort !== undefined && !runtime.state.skippedForParallelFailFast) {
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
				stageFailure = failure;
				blockedResumably = failure.disposition === "active_blocked" && failure.recoverability === "recoverable";
				applyTerminalStageState = () => applyFailureToStage(runtime.stageSnapshot, failure);
			}
			throw err;
		} finally {
			unregisterBudgetWrapUp();
			if (trackStageLifecycle) lifecycleUsers -= 1;
			const endsStage = trackStageLifecycle && lifecycleUsers === 0;
			const leftToPeer = trackStageLifecycle && !endsStage;
			if (endsStage) {
				stageEnding = true;
				if (overlapFailure !== undefined) {
					applyTerminalStageState = overlapFailure.apply;
					blockedResumably = overlapFailure.blockedResumably;
				}
			} else if (applyTerminalStageState !== undefined && !terminalStateIsSuccess && overlapFailure === undefined) {
				overlapFailure = { apply: applyTerminalStageState, blockedResumably };
				// Before this call rejects: a run that fails with its rejection names the stage it will fail (#4450).
				if (stageFailure !== undefined) runtime.scheduler.publishPendingStageFailure(runtime.stageId, stageFailure);
			}
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
				if (!leftToPeer) await runtime.drainStageSessionHeartbeat();
			} catch (err) {
				durableCheckpointError = { thrown: true, error: err };
			}
			try {
				if (!leftToPeer) {
					await runtime.innerCtx.__closeGeneration(
						(applyTerminalStageState !== undefined && !blockedResumably) ||
							runtime.state.stageClosedByWorkflowExit ||
							runtime.state.skippedForParallelFailFast ||
							runtime.exit.currentWorkflowExitAbortReason() !== undefined ||
							runtime.signal.reason === WORKFLOW_KILLED_ABORT_REASON,
					);
					if (blockedResumably)
						closeBlockedStageForGoodWhenRunEnds(runtime.activeStore, runtime.runId, async () => {
							await runtime.innerCtx.__closeGeneration(true);
						});
					await runtime.captureStageSessionMeta({ awaitDurable: true });
				}
			} catch (err) {
				durableCheckpointError ??= { thrown: true, error: err };
			}
			finalizationError ??= durableCheckpointError;
			if (endsStage) {
				// A stage whose final durability checkpoint failed must never be
				// persisted as `completed` while its caller receives that rejection.
				if (durableCheckpointError !== undefined && terminalStateIsSuccess && overlapFailure === undefined) {
					const failure = runtime.classifyExecutorFailure(durableCheckpointError.error);
					applyTerminalStageState = () => applyFailureToStage(runtime.stageSnapshot, failure);
				}
				// Keep readiness ownership through checkpointing: a consumed answer must not
				// let finalization overwrite a pause selected while the checkpoint awaited.
				try {
					if (terminalStateIsSuccess && runtime.state.readinessController !== undefined) {
						let pauseVersion: number | undefined;
						do {
							pauseVersion = runtime.state.readinessPauseVersion;
							await runtime.scheduler.waitForStageRelease(runtime.stageId, runtime.releaseLiveHandle);
						} while (pauseVersion !== runtime.state.readinessPauseVersion);
						runtime.signal.throwIfAborted();
					}
					if (!runtime.state.stageFinalized) applyTerminalStageState?.();
					// recordStageEnd publishes synchronously before its durable write yields.
					await runtime.finalizeStageSnapshot();
				} catch (err) {
					finalizationError ??= { thrown: true, error: err };
				}
				runtime.scheduler.settlePendingStageFailure(runtime.stageId);
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
			runtime.state.sessionCheckpointed = finalizationError === undefined;
			if (runtime.state.contextUnreachable) void runtime.stageRegistry.releaseIdle(runtime.runId, runtime.stageId);
			letGoSlot();
			if (finalizationError !== undefined) throwFinalizationError(finalizationError.error);
			delete runtime.state.readinessController;
			if (terminalStateIsSuccess && readinessGateEnabled) runtime.signal.throwIfAborted();
		}
	};

	return async <T>(call: () => Promise<T>, eagerSessionOrOptions?: boolean | TrackedStageCallOptions): Promise<T> => {
		runtime.state.callsInFlight += 1;
		try {
			const result = await runTrackedCall(call, eagerSessionOrOptions);
			// Counted once the call finished for the author: a durable resume answers this many calls from its record.
			runtime.state.promptsCompleted += 1;
			return result;
		} finally {
			runtime.state.callsInFlight -= 1;
			if (runtime.state.callsInFlight === 0) runtime.watchIdle();
		}
	};
}
