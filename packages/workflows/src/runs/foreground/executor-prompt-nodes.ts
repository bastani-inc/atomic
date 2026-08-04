import type { DurableStageTopology } from "../../durable/types.js";
import type { DurableUiReplayRequest } from "../../durable/ui-primitive.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import { withPromptCallerStack } from "../../shared/prompt-callsite-context.js";
import { stageUiBroker } from "../../shared/stage-ui-broker.js";
import type { Store } from "../../shared/store.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import { elapsedStageMs } from "../../shared/timing.js";
import type { WorkflowCustomUiFactory, WorkflowCustomUiOptions, WorkflowUIContext } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { ContinuationReplayIndex } from "./executor-continuation.js";
import { getPromptAnswerState, sameStringSet } from "./executor-continuation.js";
import {
	customPromptDescriptor,
	fallbackForPromptDescriptor,
	hilAbortError,
	isCustomPromptDescriptor,
	makePrompt,
	mergeHilSignals,
	type PromptDescriptor,
	promptReplayKey,
} from "./executor-hil.js";
import { applyFailureToStage, stageReplayFields } from "./executor-lifecycle.js";
import type { RunOpts, WorkflowExitCleanup } from "./executor-types.js";
import type { StageControlRegistry } from "./stage-control-registry.js";

export interface PromptNodeUiAdapter extends WorkflowUIContext {
	replayDurable(request: DurableUiReplayRequest): Promise<void>;
}

export function buildPromptNodeUiAdapter(input: {
	readonly runId: string;
	readonly activeStore: Store;
	readonly opts: RunOpts;
	readonly stageControlRegistry: StageControlRegistry;
	readonly tracker: GraphFrontierTracker;
	readonly replayIndex: ContinuationReplayIndex;
	readonly signal: AbortSignal;
	readonly throwIfWorkflowExitSelected: () => void;
	readonly registerWorkflowExitCleanup: (stageId: string, cleanup: WorkflowExitCleanup) => () => void;
	readonly workflowExitSkippedReason: (reason?: string) => string;
	readonly preserveWorkflowExitSkippedReason: (stage: StageSnapshot, fallback: string) => void;
	readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
	readonly durableTopologyForReplayKey?: (replayKey: string) => DurableStageTopology | undefined;
	/** Durably publish an unanswered prompt node before exposing its live wait. */
	readonly onPendingStage?: (runId: string, snapshot: StageSnapshot) => Promise<void>;
}): PromptNodeUiAdapter {
	const ask = async <T>(descriptor: PromptDescriptor<T>, durableReplay?: DurableUiReplayRequest): Promise<unknown> => {
		input.throwIfWorkflowExitSelected();
		const isCustom = isCustomPromptDescriptor(descriptor);
		if (input.signal.aborted) {
			if (isCustom) throw hilAbortError(input.signal);
			return fallbackForPromptDescriptor(descriptor);
		}
		if (isCustom && descriptor.options?.signal?.aborted) throw hilAbortError(descriptor.options.signal);

		const prompt = makePrompt(descriptor);
		const replayKey = promptReplayKey(descriptor);
		const durableTopology = input.durableTopologyForReplayKey?.(replayKey);
		const stageId = durableTopology?.stageId ?? crypto.randomUUID();
		const provisionalParentIds = input.tracker.onSpawn(stageId, descriptor.kind);
		const replayDecision = input.replayIndex.decide({
			displayName: descriptor.kind,
			replayKey,
			parentIds: provisionalParentIds,
			stageId,
			kind: "prompt",
		});
		const parentIds = durableTopology?.parentIds ?? replayDecision.parentIds;
		if (!sameStringSet(parentIds, provisionalParentIds)) input.tracker.replaceParents(stageId, parentIds);
		const replaySource = replayDecision.source;
		const continuationAnswer =
			replayDecision.kind === "replay"
				? input.activeStore.getStagePromptAnswer(input.opts.continuation!.source.id, replayDecision.source.id)
				: undefined;
		const replayAnswer = durableReplay === undefined ? continuationAnswer : { value: durableReplay.response };
		const shouldReplay = replayAnswer !== undefined;
		if (shouldReplay && durableReplay === undefined) input.replayIndex.markPromptAnswerReplayed(stageId);
		const replaySourceId = replaySource?.id;
		const promptAnswerStatus =
			durableReplay === undefined
				? getPromptAnswerState(shouldReplay, replaySourceId, replayDecision.answerReplay)
				: "available";
		const stageSnapshot: StageSnapshot = {
			id: stageId,
			name: descriptor.kind,
			replayKey,
			status: shouldReplay ? "completed" : "running",
			parentIds: Object.freeze(parentIds),
			startedAt: prompt.createdAt,
			promptFootprint: { ...prompt },
			toolEvents: [],
			attachable: !shouldReplay,
			...(shouldReplay
				? {
						endedAt: prompt.createdAt,
						durationMs: 0,
						promptAnswerState: promptAnswerStatus,
						replayedFromStageId: replaySourceId,
						replayed: true,
					}
				: replaySourceId !== undefined
					? {
							promptAnswerState: promptAnswerStatus,
							replayedFromStageId: replaySourceId,
							replayed: false,
						}
					: {}),
		};
		let finalized = false;
		let finalization: Promise<void> | undefined;
		let unregisterWorkflowExitCleanup = (): void => {};
		let unregisterStageControl = (): void => {};
		let pauseGate: PromiseWithResolvers<void> | undefined;
		const waitForExplicitResume = async (): Promise<void> => {
			if (pauseGate !== undefined) await pauseGate.promise;
		};
		const finalizePromptStage = async (status: "completed" | "failed" | "skipped"): Promise<void> => {
			if (finalization !== undefined) return finalization;
			finalization = (async (): Promise<void> => {
				finalized = true;
				unregisterWorkflowExitCleanup();
				unregisterStageControl();
				const currentPauseGate = pauseGate;
				pauseGate = undefined;
				currentPauseGate?.resolve();
				stageSnapshot.status = status;
				stageSnapshot.endedAt = Date.now();
				stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
				input.activeStore.recordStageAttachable(input.runId, stageId, false);
				input.activeStore.recordStageEnd(input.runId, stageSnapshot);
				await input.opts.onStageEnd?.(input.runId, stageSnapshot);
				if (input.opts.persistence) {
					appendStageEnd(input.opts.persistence, {
						runId: input.runId,
						stageId,
						status: stageSnapshot.status,
						durationMs: stageSnapshot.durationMs,
						...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
						...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
						...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
						...(stageSnapshot.failureRecoverability !== undefined
							? { failureRecoverability: stageSnapshot.failureRecoverability }
							: {}),
						...(stageSnapshot.failureDisposition !== undefined
							? { failureDisposition: stageSnapshot.failureDisposition }
							: {}),
						...(stageSnapshot.failureMessage !== undefined
							? { failureMessage: stageSnapshot.failureMessage }
							: {}),
						...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
						...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
						...stageReplayFields(stageSnapshot),
					});
				}
				input.tracker.onSettle(stageId);
			})();
			return finalization;
		};

		input.activeStore.recordStageStart(input.runId, stageSnapshot);
		input.opts.onStageStart?.(input.runId, stageSnapshot);
		unregisterStageControl = input.stageControlRegistry.register({
			runId: input.runId,
			stageId,
			stageName: descriptor.kind,
			get status() {
				return stageSnapshot.status;
			},
			sessionId: undefined,
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			async ensureAttached() {},
			async prompt() {},
			async steer() {},
			async followUp() {},
			async pause() {
				if (pauseGate === undefined) pauseGate = Promise.withResolvers<void>();
				input.activeStore.recordStagePaused(input.runId, stageId);
			},
			async resume() {
				input.activeStore.recordStageResumed(input.runId, stageId);
				// Answering a human-in-the-loop prompt continues work already in flight.
				// It is not a control action and must never reach the main chat.
				input.activeStore.recordRunResumed(input.runId, undefined, { source: "prompt_answer" });
				const currentPauseGate = pauseGate;
				pauseGate = undefined;
				currentPauseGate?.resolve();
			},
			subscribe: () => () => {},
		});
		unregisterWorkflowExitCleanup = input.registerWorkflowExitCleanup(stageId, {
			async skipForWorkflowExit(reason?: string): Promise<void> {
				if (finalized) {
					await finalization;
					return;
				}
				stageSnapshot.skippedReason = input.workflowExitSkippedReason(reason);
				if (!shouldReplay) {
					stageUiBroker.cancelStagePrompt(
						input.runId,
						stageId,
						new Error(`atomic-workflows: prompt ${stageId} skipped by workflow exit`),
					);
				}
				await finalizePromptStage("skipped");
			},
		});
		if (input.opts.persistence) {
			appendStageStart(input.opts.persistence, {
				runId: input.runId,
				stageId,
				name: stageSnapshot.name,
				parentIds: stageSnapshot.parentIds,
				...stageReplayFields(stageSnapshot),
				ts: prompt.createdAt,
			});
		}
		if (shouldReplay) {
			await Promise.resolve();
			input.throwIfWorkflowExitSelected();
			await finalizePromptStage("completed");
			return replayAnswer.value;
		}

		try {
			await input.onPendingStage?.(input.runId, stageSnapshot);
		} catch (err) {
			applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(err));
			await finalizePromptStage("failed");
			throw err;
		}

		if (isCustom) {
			if (descriptor.options?.overlay === true) {
				const error = new Error(
					"atomic-workflows: ctx.ui.custom overlay mode is unavailable in the workflow graph viewer",
				);
				applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(error));
				await finalizePromptStage("failed");
				throw error;
			}

			const mergedSignal = mergeHilSignals(input.signal, descriptor.options?.signal);
			try {
				if (mergedSignal.signal.aborted) throw hilAbortError(mergedSignal.signal);
				const accepted = input.activeStore.recordStageAwaitingInput(input.runId, stageId, true, prompt.createdAt);
				if (!accepted) {
					const error = new Error("atomic-workflows: ctx.ui.custom prompt node is unavailable");
					stageSnapshot.skippedReason = "prompt-unavailable";
					await finalizePromptStage("skipped");
					throw error;
				}
				const response = await stageUiBroker.requestCustomUi(
					input.runId,
					stageId,
					descriptor.factory as unknown as Parameters<typeof stageUiBroker.requestCustomUi>[2],
					descriptor.options as Parameters<typeof stageUiBroker.requestCustomUi>[3],
					mergedSignal.signal,
				);
				await waitForExplicitResume();
				input.activeStore.recordStagePromptAnswer(input.runId, stageId, prompt, response, {
					answerSource: "workflow_ui",
				});
				await finalizePromptStage("completed");
				return response;
			} catch (err) {
				input.activeStore.recordStageAwaitingInput(input.runId, stageId, false);
				stageUiBroker.cancelStagePrompt(input.runId, stageId, err);
				if (mergedSignal.signal.aborted) {
					input.preserveWorkflowExitSkippedReason(
						stageSnapshot,
						input.signal.aborted ? "run-aborted" : "prompt-aborted",
					);
					await finalizePromptStage("skipped");
					throw hilAbortError(mergedSignal.signal);
				}
				if (!finalized) {
					applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(err));
					await finalizePromptStage("failed");
				}
				throw err;
			} finally {
				mergedSignal.dispose();
			}
		}

		const accepted = input.activeStore.recordStagePendingPrompt(input.runId, stageId, prompt);
		if (!accepted) {
			stageSnapshot.skippedReason = "prompt-unavailable";
			await finalizePromptStage("skipped");
			return fallbackForPromptDescriptor(descriptor);
		}

		const waiter = input.activeStore.awaitStagePendingPrompt(input.runId, stageId, prompt.id);
		try {
			const response = await new Promise<unknown>((resolve, reject) => {
				const onAbort = (): void => {
					input.activeStore.resolveStagePendingPrompt(
						input.runId,
						stageId,
						prompt.id,
						fallbackForPromptDescriptor(descriptor),
						{ recordAnswer: false },
					);
					reject(hilAbortError(input.signal));
				};
				if (input.signal.aborted) {
					onAbort();
					return;
				}
				input.signal.addEventListener("abort", onAbort, { once: true });
				waiter.then(
					(value) => {
						input.signal.removeEventListener("abort", onAbort);
						resolve(value);
					},
					(err: unknown) => {
						input.signal.removeEventListener("abort", onAbort);
						reject(err);
					},
				);
			});
			await waitForExplicitResume();
			await finalizePromptStage("completed");
			return response;
		} catch (err) {
			if (input.signal.aborted) {
				input.preserveWorkflowExitSkippedReason(stageSnapshot, "run-aborted");
				await finalizePromptStage("skipped");
			} else {
				applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(err));
				await finalizePromptStage("failed");
			}
			throw err;
		}
	};

	return {
		async replayDurable(request: DurableUiReplayRequest): Promise<void> {
			await withPromptCallerStack(request.callerStack, async () => {
				if (request.kind === "input") {
					await ask({ kind: "input", message: request.promptText }, request);
				} else if (request.kind === "confirm") {
					await ask({ kind: "confirm", message: request.message }, request);
				} else if (request.kind === "select") {
					await ask({ kind: "select", message: request.message, choices: request.options }, request);
				} else if (request.kind === "editor") {
					await ask({ kind: "editor", message: "Edit and save to continue.", initial: request.initial }, request);
				} else {
					await ask(customPromptDescriptor(request.factory, request.options), request);
				}
			});
		},
		async input(promptText: string): Promise<string> {
			const response = await ask({ kind: "input", message: promptText });
			return typeof response === "string" ? response : String(response ?? "");
		},
		async confirm(message: string): Promise<boolean> {
			const response = await ask({ kind: "confirm", message });
			return response === true;
		},
		async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
			if (options.length === 0) throw new Error("atomic-workflows: ctx.ui.select requires at least one option");
			const response = await ask({ kind: "select", message, choices: options });
			if (typeof response === "string" && (options as readonly string[]).includes(response)) return response as T;
			return options[0]!;
		},
		async editor(initial?: string): Promise<string> {
			const response = await ask({ kind: "editor", message: "Edit and save to continue.", initial });
			return typeof response === "string" ? response : (initial ?? "");
		},
		async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
			const response = await ask(customPromptDescriptor(factory, options));
			return response as T;
		},
	};
}
