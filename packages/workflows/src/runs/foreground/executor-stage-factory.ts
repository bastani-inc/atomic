import { type QuestionParams, type ReleasedAgentSession, runCallback, runSynchronousCallback } from "@bastani/atomic";
import type { DurableReleasedStageResume } from "../../durable/types.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { EngineStageRuntimeOptions } from "../../engine/options.js";
import type { RunBudgetController } from "../../engine/run-budget.js";
import { setStageWorkingDirectory, stageWorkingDirectory } from "../../engine/stage-workspace.js";
import type { StageLifecycleEvent, StageWaitSnapshot } from "../../shared/authoring-contract-stage.js";
import { resolveStageGroup, stageCanUseWorkflowPendingStageRoute } from "../../shared/intercom-group.js";
import { workflowPendingStageRouteReady } from "../../shared/pending-stage-route-readiness.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import { provideStageQuestion } from "../../shared/stage-question-form.js";
import type { StageUiBroker } from "../../shared/stage-ui-broker.js";
import {
	parseReleaseWhenWaiting,
	recordStageWaitToolResults,
	resolveStageReleasePolicy,
	STAGE_WAIT_RETRY_ATTEMPTS,
	STAGE_WAIT_RETRY_BUDGET_MS,
	stageWaitRetryDelayMs,
} from "../../shared/stage-wait.js";
import { StageWaitRecordError, type StageWaitRecordPhase } from "../../shared/stage-wait-errors.js";
import type { Store } from "../../shared/store.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import { elapsedStageMs, rebasedStageStartedAt, stageTimingFields } from "../../shared/timing.js";
import type { StageOptions, WorkflowArtifact } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { ConcurrencyLimiter } from "../shared/concurrency.js";
import { sleepOrAbort } from "../shared/retry.js";
import type { ContinuationReplayIndex } from "./executor-continuation.js";
import { sameStringSet } from "./executor-continuation.js";
import {
	type GitWorktreeSetupCache,
	stageOptionsWithGitWorktree,
	stageOptionsWithInputDefaults,
} from "./executor-direct-helpers.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import { askUserQuestionToolEvent, toolResultChatText, toolResultHasChatAnswer } from "./executor-hil.js";
import { stageReplayFields } from "./executor-lifecycle.js";
import { createQueuedUserMessageConsumptionWatcher } from "./executor-queued-user-message.js";
import type { StageScheduler } from "./executor-scheduler.js";
import { isTerminalStage } from "./executor-scheduler.js";
import { createTrackedStageCaller } from "./executor-stage-call.js";
import { createStageContext } from "./executor-stage-context.js";
import { createStageControlHandle } from "./executor-stage-control.js";
import { createReplayStageContext } from "./executor-stage-replay.js";
import type {
	LiveStageMutableState,
	LiveStageRuntime,
	StageContextWithMeta,
	StageMcpScope,
} from "./executor-stage-types.js";
import type { ParallelFailFastScope, StageSessionCheckpointOptions } from "./executor-types.js";
import { createWorkflowPendingStageDelivery } from "./pending-stage-delivery.js";
import type { RunStageResidency } from "./run-residency.js";
import { StageAbortListeners } from "./stage-abort-listeners.js";
import { recordStageSessionCompaction } from "./stage-background-compaction.js";
import type { StageControlRegistry } from "./stage-control-registry.js";
import { type IdleStage, stageIdleReleaser } from "./stage-idle-release.js";
import {
	createStageContext as createInnerStageContext,
	type InternalStageContext,
	type StageAdapters,
} from "./stage-runner.js";
import { readReplayedStageMessages } from "./stage-runner-options.js";
import { stageError } from "./stage-runner-session.js";
import type { StageWaitHooks } from "./stage-runner-types.js";
import { createStageSessionHeartbeat } from "./stage-session-heartbeat.js";
import { type StageWakeDispatcher, stageWakeKey } from "./stage-wake-dispatcher.js";

export function agentStageReplayKey(name: string, options: StageOptions | undefined): string {
	return options?.durableReplayKey ?? `stage:${name}`;
}

export function createWorkflowStageFactory(input: {
	readonly runId: string;
	readonly workflowIntercomGroup: string;
	readonly activeStore: Store;
	readonly opts: EngineStageRuntimeOptions;
	readonly adapters: StageAdapters;
	readonly signal: AbortSignal;
	readonly tracker: GraphFrontierTracker;
	readonly scheduler: StageScheduler;
	readonly replayIndex: ContinuationReplayIndex;
	readonly limiter: ConcurrencyLimiter;
	readonly inputRuntimeDefaults: Partial<StageOptions>;
	readonly workflowInvocationCwd: string;
	readonly gitWorktreeSetupCache: GitWorktreeSetupCache;
	readonly stageRegistry: StageControlRegistry;
	readonly stageUiBroker: StageUiBroker;
	readonly exit: WorkflowExitManager;
	readonly budget: RunBudgetController;
	readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
	readonly createMcpScope: (stageId: string, options: StageOptions | undefined) => StageMcpScope;
	readonly takeTerminalArtifacts?: (replayKey: string) => readonly WorkflowArtifact[] | undefined;
	readonly assertLiveWorkAllowed?: () => void;
	readonly wakeDispatcher: StageWakeDispatcher;
	readonly stageResidency?: RunStageResidency | undefined;
}): (
	name: string,
	options?: StageOptions,
	stageFailFastScope?: ParallelFailFastScope,
	prepareLiveOptions?: () => StageOptions | undefined,
) => StageContextWithMeta {
	const runReleasePolicy = parseReleaseWhenWaiting(input.opts.releaseWhenWaiting);
	const wakeDispatcher = input.wakeDispatcher;
	let residentReported = false;
	// One idle scan for the whole run: no stage owns a timer.
	const idleReleaser = stageIdleReleaser(wakeDispatcher, (stageId, error) => {
		console.warn(`atomic-workflows: run ${input.runId} could not release idle stage ${stageId}`, error);
	});
	return (name, options, stageFailFastScope, prepareLiveOptions): StageContextWithMeta => {
		input.exit.throwIfWorkflowExitSelected();
		options = stageOptionsWithInputDefaults(options, input.inputRuntimeDefaults);
		const releasePolicy = resolveStageReleasePolicy(options?.releaseWhenWaiting, runReleasePolicy, name);
		const stageId = options?.durableStageId ?? crypto.randomUUID();
		const provisionalParentIds = input.tracker.onSpawn(stageId, name);
		if (stageFailFastScope?.detached === true) input.tracker.detach(stageId);
		const scopedParentIds =
			options?.durableParentIds ??
			(input.opts.continuation === undefined || stageFailFastScope?.detached === true
				? stageFailFastScope?.parentIds
				: undefined);
		const initialParentIds = scopedParentIds === undefined ? provisionalParentIds : [...scopedParentIds];
		if (scopedParentIds !== undefined && !sameStringSet(scopedParentIds, provisionalParentIds)) {
			input.tracker.replaceParents(stageId, scopedParentIds);
		}

		const replayKey = agentStageReplayKey(name, options);
		const replayDecision = input.replayIndex.decide({
			displayName: name,
			replayKey,
			parentIds: initialParentIds,
			stageId,
			kind: "stage",
		});
		const parentIds = options?.durableParentIds ?? replayDecision.parentIds;
		if (!sameStringSet(parentIds, provisionalParentIds)) input.tracker.replaceParents(stageId, parentIds);
		const replaySource = replayDecision.kind === "replay" ? replayDecision.source : undefined;
		const executeReplaySource = replayDecision.kind === "execute" ? replayDecision.source : undefined;
		const shouldReplay = replaySource !== undefined;
		if (!shouldReplay) {
			input.assertLiveWorkAllowed?.();
			options = stageOptionsWithGitWorktree(
				prepareLiveOptions?.() ?? options,
				input.workflowInvocationCwd,
				input.gitWorktreeSetupCache,
			);
		}
		const replayStageOptions: StageOptions | undefined =
			executeReplaySource?.sessionId === undefined
				? options
				: {
						...(options ?? {}),
						routerSelection: executeReplaySource.routerSelection,
						context: options?.context ?? "fork",
						forkFromSessionId: options?.forkFromSessionId ?? executeReplaySource.sessionId,
						forkFromEntryId: options?.forkFromSessionId === undefined ? undefined : options.forkFromEntryId,
					};
		const intercomGroup =
			options?.durableIntercomGroup ?? resolveStageGroup(replayStageOptions, input.workflowIntercomGroup);
		const stageOptionsForContext =
			replayStageOptions?.group === undefined || intercomGroup === undefined
				? replayStageOptions
				: { ...replayStageOptions, group: intercomGroup };
		const pendingStageDeliveryAvailable = stageCanUseWorkflowPendingStageRoute(
			stageOptionsForContext,
			input.workflowIntercomGroup,
		);

		const stageSnapshot: StageSnapshot = {
			id: stageId,
			name,
			...(intercomGroup === undefined ? {} : { intercomGroup }),
			replayKey,
			status: shouldReplay ? "completed" : "pending",
			parentIds: Object.freeze(parentIds),
			toolEvents: [],
			pendingStageDeliveryAvailable,
			...(options?.sessionStore === undefined && options?.sessionManager === undefined
				? {}
				: { sessionStorage: "stage" as const }),
			...(shouldReplay
				? {
						...stageTimingFields(replaySource),
						...(replaySource.result !== undefined ? { result: replaySource.result } : {}),
						...(replaySource.sessionId !== undefined ? { sessionId: replaySource.sessionId } : {}),
						...(replaySource.sessionFile !== undefined ? { sessionFile: replaySource.sessionFile } : {}),
						...(replaySource.model !== undefined ? { model: replaySource.model } : {}),
						...(replaySource.thinkingLevel !== undefined ? { thinkingLevel: replaySource.thinkingLevel } : {}),
						replayedFromStageId: replaySource.id,
						replayed: true,
					}
				: {}),
			...(options?.mcp !== undefined
				? { mcpScope: { allow: options.mcp.allow ?? null, deny: options.mcp.deny ?? null } }
				: {}),
			attachable: !shouldReplay,
		};
		setStageWorkingDirectory(stageSnapshot, options?.cwd);

		if (shouldReplay) {
			return createReplayStageContext({
				runId: input.runId,
				name,
				stageId,
				stageSnapshot,
				replaySource,
				activeStore: input.activeStore,
				opts: input.opts,
				tracker: input.tracker,
				registerWorkflowExitCleanup: input.exit.registerWorkflowExitCleanup,
				workflowExitSkippedReason: input.exit.workflowExitSkippedReason,
				throwIfWorkflowExitSelected: input.exit.throwIfWorkflowExitSelected,
				readStoredMessages: (sessionId) =>
					readReplayedStageMessages(
						options ?? {},
						{
							adapters: input.adapters,
							defaultSessionDir: input.opts.defaultSessionDir,
							defaultCwd: input.workflowInvocationCwd,
						},
						sessionId,
					),
			}) as StageContextWithMeta;
		}
		// A resumed stage keeps the results its previous process recorded in every record it writes, until the turn that
		// consumes them is saved: a process that stops before then leaves them for the next resume (#4309).
		const keptResults =
			options?.durableReplayKey === undefined
				? undefined
				: wakeDispatcher.resultsKeptForResume(options.durableReplayKey);
		if (keptResults !== undefined) stageSnapshot.waitResults = recordStageWaitToolResults(keptResults);

		const applyModelFallbackMeta = (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>): void => {
			if (meta.model !== undefined) stageSnapshot.model = meta.model;
			if (meta.thinkingLevel !== undefined) stageSnapshot.thinkingLevel = meta.thinkingLevel;
			else delete stageSnapshot.thinkingLevel;
			if (meta.attemptedModels !== undefined) stageSnapshot.attemptedModels = meta.attemptedModels;
			if (meta.modelAttempts !== undefined) stageSnapshot.modelAttempts = meta.modelAttempts;
			if (meta.rateLimits !== undefined) stageSnapshot.rateLimits = meta.rateLimits;
			if (meta.routerSelection !== undefined) stageSnapshot.routerSelection = meta.routerSelection;
			if (meta.warnings !== undefined) {
				if (meta.warnings.length > 0) stageSnapshot.warnings = meta.warnings;
				else delete stageSnapshot.warnings;
			}
		};

		let runtime!: LiveStageRuntime;
		const emitLifecycleEvent = (event: StageLifecycleEvent): void => {
			const listener = input.opts.onStageLifecycleEvent;
			if (listener === undefined) return;
			const reportFailure = (error: Error | string | object): void => {
				console.error(`atomic-workflows: onStageLifecycleEvent listener failed on ${event.type}`, error);
			};
			try {
				void Promise.resolve(listener(input.runId, event)).catch(reportFailure);
			} catch (error) {
				reportFailure(error as Error);
			}
		};
		let statusBeforeRelease: StageSnapshot["status"] | undefined;
		/** The wait the stage shows, with the calls it had finished when it released. */
		let shownWait: StageWaitSnapshot | undefined;
		const showWait = (wait: StageWaitSnapshot): void => {
			shownWait = wait;
			stageSnapshot.wait = wait;
			// A stage waiting on a human keeps showing that it awaits input; its `wait` marks the released session.
			if (wait.kind === "prompt") return;
			// A stage released between turns goes back to how it was when it is rehydrated, or when the workflow ends.
			statusBeforeRelease =
				wait.kind !== "tool" || stageSnapshot.status === "completed" || stageSnapshot.status === "failed"
					? stageSnapshot.status
					: undefined;
			if (stageSnapshot.status !== "paused") stageSnapshot.status = "waiting";
			if (wait.kind !== "tool") idleReleaser.trackReleased(stageId, settleReleased);
		};
		const settleReleased = (): void => {
			shownWait = undefined;
			delete stageSnapshot.wait;
			if (stageSnapshot.status === "waiting") stageSnapshot.status = statusBeforeRelease ?? "completed";
			input.activeStore.recordStageStart(input.runId, stageSnapshot);
		};
		const wakeKey = stageWakeKey(input.runId, stageId);
		wakeDispatcher.open({ runId: input.runId, stageId, wakeKey, replayKey });
		const giveBackSlot = (): void => {
			if (state.limiterSlot !== "held") return;
			state.limiterSlot = "released";
			input.limiter.release();
		};
		let waitRecordFailureReported = false;
		/** The stage's current wait could not be recorded: a replay would not find it, so its run is not evicted. */
		let waitRecordMissing = false;
		/** A wait record that failed every attempt: the stage carries on, and shows why its record may be behind. */
		const degradeWaitRecord = (failure: StageWaitRecordError): void => {
			stageSnapshot.waitRecordFailure = failure.toJSON();
			input.activeStore.recordStageStart(input.runId, stageSnapshot);
			if (waitRecordFailureReported) return;
			waitRecordFailureReported = true;
			console.warn(`atomic-workflows: run ${input.runId}: ${failure.message}`);
		};
		/**
		 * Write one of the stage's wait records durably, tried again as a reopening is, and say whether it was written. A
		 * record that still fails does not stop the stage; only the run's abort does, with its reason.
		 */
		const recordWait = async (phase: StageWaitRecordPhase): Promise<boolean> => {
			const startedAt = Date.now();
			for (let attempt = 1; ; attempt++) {
				try {
					await runtime.captureStageSessionMeta({ forceDurable: true });
					return true;
				} catch (error) {
					if (input.signal.aborted) throw input.signal.reason;
					if (attempt >= STAGE_WAIT_RETRY_ATTEMPTS) {
						degradeWaitRecord(
							new StageWaitRecordError(
								{
									runId: input.runId,
									stageId,
									stageName: name,
									...(stageSnapshot.sessionId === undefined ? {} : { sessionId: stageSnapshot.sessionId }),
									phase,
									attempts: attempt,
									elapsedMs: Date.now() - startedAt,
									timeoutMs: STAGE_WAIT_RETRY_BUDGET_MS,
								},
								{ cause: error },
							),
						);
						return false;
					}
				}
				await sleepOrAbort(stageWaitRetryDelayMs(attempt), input.signal);
			}
		};
		const waiting: StageWaitHooks = {
			policy: releasePolicy,
			dispatcher: wakeDispatcher,
			wakeKey,
			async enter(wait, restored = false) {
				idleReleaser.unwatch(stageId);
				stageSessionHeartbeat.stop();
				runtime.abortListeners.detach();
				giveBackSlot();
				const recorded: StageWaitSnapshot = { ...wait, promptsCompleted: state.promptsCompleted };
				showWait(recorded);
				input.activeStore.recordStageStart(input.runId, stageSnapshot);
				if (!restored) {
					waitRecordMissing = !(await recordWait("wait-start"));
					emitLifecycleEvent({ type: "stage_waiting", stageId, stageName: name, wait: recorded });
				}
				input.stageResidency?.changed();
			},
			async recordResults(_wait, results) {
				stageSnapshot.waitResults = recordStageWaitToolResults(results);
				await recordWait("wait-results");
			},
			resultsInTranscript() {
				delete stageSnapshot.waitResults;
			},
			async leave() {
				waitRecordMissing = false;
				idleReleaser.forgetReleased(stageId);
				if (state.limiterSlot === "released") {
					await input.limiter.acquire(input.signal);
					state.limiterSlot = "held";
				}
				runtime.abortListeners.attach();
				delete stageSnapshot.wait;
				if (stageSnapshot.status === "waiting") stageSnapshot.status = statusBeforeRelease ?? "running";
				statusBeforeRelease = undefined;
				input.activeStore.recordStageStart(input.runId, stageSnapshot);
			},
			async reopenFailed(wait) {
				runtime.abortListeners.detach();
				giveBackSlot();
				showWait(shownWait ?? wait);
				input.activeStore.recordStageStart(input.runId, stageSnapshot);
			},
			resident(reason) {
				if (residentReported) return;
				residentReported = true;
				console.warn(`atomic-workflows: run ${input.runId} keeps waiting stages resident: ${reason.message}`);
			},
			async rehydrated(wait) {
				const ended = shownWait ?? wait;
				shownWait = undefined;
				if (stageSnapshot.status === "running" || (wait.kind === "prompt" && state.callsInFlight > 0))
					stageSessionHeartbeat.start();
				// The record that ends the durable wait lands before the stage goes on, so a resume from any later point
				// never treats the stage as still waiting.
				await recordWait("wait-end");
				watchIdle();
				emitLifecycleEvent({
					type: "stage_rehydrated",
					stageId,
					stageName: name,
					wait: ended,
					waitedMs: Math.max(0, Date.now() - ended.since),
				});
			},
		};
		/** The run's idle scan releases this stage once the workflow has held it unused for its threshold. */
		const idleStage: IdleStage | undefined =
			releasePolicy === undefined
				? undefined
				: {
						afterMs: releasePolicy.afterMs,
						idleSince: () =>
							state.callsInFlight > 0 || handle.releaseGate?.idle() !== true
								? undefined
								: innerCtx.__idleSince(),
						release: async () => {
							if ((await innerCtx.__releaseIdle()) !== true) watchIdle();
						},
					};
		const watchIdle = (): void => {
			input.stageResidency?.changed();
			if (
				idleStage === undefined ||
				state.liveHandleReleased ||
				state.contextUnreachable ||
				innerCtx.__isReleased() === true
			)
				return;
			idleReleaser.watch(stageId, idleStage);
		};
		const stopIdleWatch = (): void => {
			state.contextUnreachable = true;
			idleReleaser.unwatch(stageId);
		};
		const stageSessionHeartbeat = createStageSessionHeartbeat(async () => {
			try {
				await runtime.captureStageSessionMeta({ awaitDurable: true });
			} catch (error) {
				await runtime.innerCtx.abort().catch(() => {});
				throw error;
			}
		});
		const innerCtx = createInnerStageContext({
			stageId,
			stageName: name,
			adapters: input.adapters,
			runId: input.runId,
			workflowIntercomGroup: input.workflowIntercomGroup,
			signal: input.signal,
			stageOptions: stageOptionsForContext,
			...(pendingStageDeliveryAvailable
				? {
						routeAuthorityReady: () => workflowPendingStageRouteReady(input.activeStore, input.runId),
						pendingStageDelivery: createWorkflowPendingStageDelivery(
							input.activeStore,
							input.runId,
							stageId,
							name,
						),
					}
				: {}),
			models: input.opts.models,
			executionMode: input.opts.executionMode,
			defaultSessionDir: input.opts.defaultSessionDir,
			defaultCwd: input.workflowInvocationCwd,
			waiting,
			onStartupChange(startup) {
				// Never add a retired stage to a replacement run with the same identity.
				const current = input.activeStore.run(input.runId);
				if (!current?.stages.includes(stageSnapshot)) return;
				stageSnapshot.startup = startup;
				input.activeStore.recordStageStart(input.runId, stageSnapshot);
			},
			onModelFallbackMetaChange(meta) {
				applyModelFallbackMeta(meta);
				if (stageSnapshot.status === "running") input.activeStore.recordStageStart(input.runId, stageSnapshot);
			},
			async onSessionReady() {
				watchIdle();
				if (stageSnapshot.status !== "running") return;
				await runtime.captureStageSessionMeta({ awaitDurable: true });
				runtime.startStageSessionHeartbeat();
			},
			...(input.opts.onStageSessionEvent === undefined
				? {}
				: {
						onSessionEvent: (event) => input.opts.onStageSessionEvent?.(input.runId, stageId, event),
					}),
		});

		const state: LiveStageMutableState = {
			activeAskUserQuestionAnonymousCalls: 0,
			askUserQuestionObservedThisTurn: false,
			userMessageSeq: 0,
			chatAnswerObservedThisTurn: false,
			resumeContinuationPending: false,
			suppressQueuedUserMessageContinuation: false,
			waitingForStageChatTurn: false,
			wakeWaitingForStageChatTurn: undefined,
			liveHandleReleased: false,
			stageClosedByWorkflowExit: false,
			stageFinalized: false,
			sessionCheckpointed: false,
			skippedForParallelFailFast: false,
			stageControlDropped: false,
			contextUnreachable: false,
			limiterSlot: "none",
			promptsCompleted: 0,
			callsInFlight: 0,
		};
		const activeAskUserQuestionCalls = new Set<string>();
		const hasActiveAskUserQuestion = (): boolean =>
			activeAskUserQuestionCalls.size > 0 || state.activeAskUserQuestionAnonymousCalls > 0;
		const unsubscribeAskUserQuestionWatcher = innerCtx.subscribe((event) => {
			const toolEvent = askUserQuestionToolEvent(event);
			if (!toolEvent) return;
			if (toolEvent.phase === "start") {
				state.askUserQuestionObservedThisTurn = true;
				state.latestUserMessage = undefined;
				if (toolEvent.callId !== undefined) activeAskUserQuestionCalls.add(toolEvent.callId);
				else state.activeAskUserQuestionAnonymousCalls += 1;
				provideStageQuestion(
					input.stageUiBroker,
					input.runId,
					stageId,
					toolEvent.callId ?? `ask-user-question-${stageId}`,
					"ask_user_question",
					toolEvent.args as QuestionParams,
				);
				input.activeStore.recordStageAwaitingInput(input.runId, stageId, true);
				return;
			}
			if (toolEvent.callId !== undefined && activeAskUserQuestionCalls.has(toolEvent.callId)) {
				activeAskUserQuestionCalls.delete(toolEvent.callId);
			} else if (toolEvent.callId === undefined && toolEvent.nameMatched) {
				state.activeAskUserQuestionAnonymousCalls = Math.max(0, state.activeAskUserQuestionAnonymousCalls - 1);
			} else {
				return;
			}
			if (toolResultHasChatAnswer((event as Record<string, unknown>).result))
				state.chatAnswerObservedThisTurn = true;
			state.latestUserMessage =
				toolResultChatText((event as Record<string, unknown>).result) ?? state.latestUserMessage;
			if (!hasActiveAskUserQuestion()) {
				input.activeStore.recordStageAwaitingInput(input.runId, stageId, false);
				input.stageUiBroker.clearStagePrompt(input.runId, stageId);
			}
		});
		const unsubscribeQueuedUserMessageWatcher = innerCtx.subscribe(
			createQueuedUserMessageConsumptionWatcher(() => {
				if (!state.suppressQueuedUserMessageContinuation) {
					state.resumeContinuationPending = "queued-user-message";
				}
			}),
		);

		const disposeInnerContext = async (): Promise<void> => {
			idleReleaser.unwatch(stageId);
			unsubscribeAskUserQuestionWatcher();
			unsubscribeQueuedUserMessageWatcher();
			activeAskUserQuestionCalls.clear();
			state.activeAskUserQuestionAnonymousCalls = 0;
			input.activeStore.recordStageAwaitingInput(input.runId, stageId, false);
			input.stageUiBroker.clearStagePrompt(input.runId, stageId);
			const session = innerCtx.__agentSession();
			try {
				await innerCtx.__dispose();
			} finally {
				// The stage's mailbox lives as long as the stage.
				wakeDispatcher.close(wakeKey);
			}
			recordStageSessionCompaction(input.activeStore, input.runId, stageId, session);
		};

		const captureStageSessionMeta = async (checkpointOptions?: StageSessionCheckpointOptions): Promise<void> => {
			const meta = innerCtx.__sessionMeta();
			if (meta.sessionId !== undefined) stageSnapshot.sessionId = meta.sessionId;
			if (meta.sessionFile !== undefined) stageSnapshot.sessionFile = meta.sessionFile;
			if (meta.sessionId !== undefined)
				input.activeStore.recordStageSession(input.runId, stageId, { sessionId: meta.sessionId });
			const pending = input.opts.onStageSession?.(input.runId, stageSnapshot, checkpointOptions);
			if (checkpointOptions?.forceDurable === true || checkpointOptions?.awaitDurable === true) {
				await pending;
				return;
			}
			void Promise.resolve(pending).catch(() => {});
		};
		const releaseLiveHandle = async (): Promise<void> => {
			if (state.liveHandleReleased) return;
			state.liveHandleReleased = true;
			stageSessionHeartbeat.stop();
			runtime.dropStageControlHandle();
			runtime.unregisterStageHandle();
			await disposeInnerContext();
		};
		const dropStageControlForCompletion = async (): Promise<void> => {
			runtime.dropStageControlHandle();
			// A registry/session clear can release a confirmed-paused handle before
			// its owner resumes. The handle is then ownerless, so normal completion
			// must make the second disposal call that drains the controller's deferred
			// cleanup instead of retaining the session and its listeners forever.
			if (state.liveHandleReleased) await disposeInnerContext();
		};
		const throwIfStageMutationBlocked = (): void => {
			if (state.stageClosedByWorkflowExit) {
				input.exit.throwIfWorkflowExitSelected();
				throw stageError(name, "skipped by workflow exit");
			}
			input.exit.throwIfWorkflowExitSelected();
			if (input.signal.aborted) {
				throw input.signal.reason ?? new DOMException("workflow killed", "AbortError");
			}
		};

		let stageStartEntry: Promise<void> | undefined;
		const appendStageStartOnce = (): Promise<void> => {
			if (!input.opts.persistence) return Promise.resolve();
			stageStartEntry ??= appendStageStart(input.opts.persistence, {
				runId: input.runId,
				stageId,
				name,
				parentIds: stageSnapshot.parentIds,
				...stageReplayFields(stageSnapshot),
				...(intercomGroup === undefined ? {} : { intercomGroup }),
				pendingStageDeliveryAvailable,
				ts: stageSnapshot.startedAt ?? Date.now(),
			});
			return stageStartEntry;
		};

		const finalizeStageSnapshot = async (): Promise<boolean> => {
			stageSessionHeartbeat.stop();
			if (state.stageFinalized) return false;
			if (stageSnapshot.endedAt !== undefined && isTerminalStage(stageSnapshot)) {
				state.stageFinalized = true;
				runtime.unregisterWorkflowExitCleanup();
				stageFailFastScope?.activeStages.delete(stageId);
				input.tracker.onSettle(stageId);
				return false;
			}
			if (state.skippedForParallelFailFast) {
				stageSnapshot.status = "skipped";
				stageSnapshot.skippedReason = "fail-fast";
			}
			state.stageFinalized = true;
			runtime.unregisterWorkflowExitCleanup();
			stageSnapshot.endedAt = Date.now();
			stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
			applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
			const artifacts = input.takeTerminalArtifacts?.(replayKey);
			if (artifacts !== undefined && artifacts.length > 0) stageSnapshot.artifacts = artifacts;
			input.activeStore.recordStageEnd(input.runId, stageSnapshot);
			input.stageUiBroker.cancelStagePrompt(
				input.runId,
				stageId,
				new Error(`atomic-workflows: stage ${stageId} completed with pending custom UI`),
			);
			input.stageUiBroker.clearStageStatuses(input.runId, stageId);
			if (input.opts.onStageEnd) {
				await runCallback(
					{ kind: "workflow.stage_adapter", name: `onStageEnd:${name}`, runId: input.runId, stageId },
					() => input.opts.onStageEnd!(input.runId, stageSnapshot),
				);
			}
			if (input.opts.persistence) {
				await appendStageStartOnce();
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
					...(stageSnapshot.modelAttempts !== undefined ? { modelAttempts: stageSnapshot.modelAttempts } : {}),
					...(stageSnapshot.rateLimits !== undefined ? { rateLimits: stageSnapshot.rateLimits } : {}),
					...(stageSnapshot.routerSelection !== undefined
						? { routerSelection: stageSnapshot.routerSelection }
						: {}),
					...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed"
						? { summary: stageSnapshot.result }
						: {}),
					...stageReplayFields(stageSnapshot),
				});
			}
			stageFailFastScope?.activeStages.delete(stageId);
			input.tracker.onSettle(stageId);
			return true;
		};

		const markSkippedForParallelFailFast = (): void => {
			// Defer graph-visible fields until `finalizeStageSnapshot`, directly
			// before its version-bumping `recordStageEnd` call.
			state.skippedForParallelFailFast = true;
		};
		const parallelFailFastError = (): unknown =>
			stageFailFastScope?.firstFailure ?? new Error("atomic-workflows: skipped after parallel fail-fast");

		/** The calls a durable resume answers from the run's record, set only for a stage resumed released. */
		let replay: { remaining: number; readonly recorded: DurableReleasedStageResume["recorded"] } | undefined;
		/** Complete the stage's replayed first call as its previous process did, from the recorded result. */
		const completeFromRecord = async (
			recorded: DurableReleasedStageResume["recorded"],
		): Promise<DurableReleasedStageResume["recorded"]> => {
			stageSnapshot.startedAt ??= rebasedStageStartedAt(options?.durableAccumulatedDurationMs, Date.now());
			stageSnapshot.status = "completed";
			const text = recorded?.result ?? (typeof recorded?.output === "string" ? recorded.output : undefined);
			if (text !== undefined) stageSnapshot.result = text;
			if (recorded?.structured !== undefined) stageSnapshot.structured = recorded.structured;
			// The wait stays on the record written now, so a second restart still finds the stage waiting.
			await appendStageStartOnce();
			await finalizeStageSnapshot();
			state.sessionCheckpointed = true;
			await dropStageControlForCompletion();
			if (shownWait !== undefined) {
				statusBeforeRelease = "completed";
				stageSnapshot.status = "waiting";
				input.activeStore.recordStageStart(input.runId, stageSnapshot);
			}
			return recorded;
		};
		const replayRecordedCall = (): Promise<DurableReleasedStageResume["recorded"]> | undefined => {
			const plan = replay;
			if (plan === undefined) return undefined;
			plan.remaining -= 1;
			if (plan.remaining <= 0) replay = undefined;
			state.promptsCompleted += 1;
			return state.stageFinalized ? Promise.resolve(undefined) : completeFromRecord(plan.recorded);
		};
		/** Set for a stage resumed inside a tool wait after earlier calls: its first live call continues that turn. */
		let waitingTurnPending = false;
		const resumeReleased = (resume: DurableReleasedStageResume): void => {
			if (innerCtx.__isReleased() === true || state.callsInFlight > 0 || state.stageFinalized) return;
			if (resume.wait.kind === "tool") {
				replay = { remaining: resume.promptsCompleted, recorded: resume.recorded };
				waitingTurnPending = true;
				stageSnapshot.sessionId = resume.sessionId;
				// The records the replayed calls write keep the wait, so a replay after this one still finds it.
				stageSnapshot.wait = resume.wait;
				return;
			}
			innerCtx.__startReleased(resume.wait, resume.sessionId);
			if (innerCtx.__isReleased() !== true) return;
			if (resume.promptsCompleted > 0) replay = { remaining: resume.promptsCompleted, recorded: resume.recorded };
			stageSnapshot.sessionId = resume.sessionId;
			runtime.abortListeners.detach();
			showWait(resume.wait);
			input.activeStore.recordStageStart(input.runId, stageSnapshot);
			emitLifecycleEvent({ type: "stage_waiting", stageId, stageName: name, wait: resume.wait });
		};
		const takeWaitingTurn = (): boolean => {
			if (!waitingTurnPending) return false;
			waitingTurnPending = false;
			// A stage whose wait no evicted run handed over starts a new turn of its own, which no longer waits.
			if (!wakeDispatcher.holdsToolWaitForResume(replayKey)) delete stageSnapshot.wait;
			return true;
		};
		/**
		 * Wait for the answer to the stage's readiness question. The run's idle scan releases the session once the
		 * question has waited for the stage's threshold; the session is reopened when the answer arrives.
		 */
		const awaitPromptAnswer = async <T>(answer: Promise<T>): Promise<T> => {
			if (releasePolicy === undefined) return answer;
			const askedAt = Date.now();
			/** Settles with whether the stage gave its session up for the question, however its release ended. */
			const gate: { released?: Promise<boolean> } = {};
			idleReleaser.watch(stageId, {
				afterMs: releasePolicy.afterMs,
				idleSince: () => askedAt,
				release: () => {
					const releasing = innerCtx.__releaseForPrompt();
					// A release that failed is reported once, by the idle scan this returns to; what counts is whether
					// the session went before it failed.
					gate.released = releasing.then(
						(released) => released,
						() => innerCtx.__isReleased() === true,
					);
					return releasing.then(() => undefined);
				},
			});
			try {
				return await answer;
			} finally {
				idleReleaser.unwatch(stageId);
				const released = gate.released !== undefined && (await gate.released);
				if (released && !input.signal.aborted) await innerCtx.rehydrate();
				else watchIdle();
			}
		};

		runtime = {
			runId: input.runId,
			stageId,
			name,
			stageSnapshot,
			innerCtx,
			activeStore: input.activeStore,
			opts: input.opts,
			stageRegistry: input.stageRegistry,
			stageUiBroker: input.stageUiBroker,
			scheduler: input.scheduler,
			signal: input.signal,
			exit: input.exit,
			budget: input.budget,
			classifyExecutorFailure: input.classifyExecutorFailure,
			mcpScope: input.createMcpScope(stageId, options),
			...(stageFailFastScope !== undefined ? { stageFailFastScope } : {}),
			state,
			abortListeners: new StageAbortListeners(input.signal),
			unregisterStageHandle: () => {},
			dropStageControlHandle: () => {},
			unregisterWorkflowExitCleanup: () => {},
			captureStageSessionMeta,
			startStageSessionHeartbeat: stageSessionHeartbeat.start,
			drainStageSessionHeartbeat: stageSessionHeartbeat.drain,
			raceStageSessionHeartbeat: stageSessionHeartbeat.race,
			applyModelFallbackMeta,
			appendStageStartOnce,
			finalizeStageSnapshot,
			releaseLiveHandle,
			dropStageControlForCompletion,
			markSkippedForParallelFailFast,
			parallelFailFastError,
			throwIfStageMutationBlocked,
			replayRecordedCall,
			takeWaitingTurn,
			resumesEvictedWait: () => wakeDispatcher.holdsToolWaitForResume(replayKey),
			resumeReleased,
			awaitPromptAnswer,
			watchIdle,
			stopIdleWatch,
		};

		const handle = createStageControlHandle(runtime);
		runtime.dropStageControlHandle = (): void => {
			if (state.stageControlDropped) return;
			state.stageControlDropped = true;
			input.activeStore.recordStageAttachable(input.runId, stageId, false);
			input.stageRegistry.detachControl(input.runId, stageId, handle);
		};
		runtime.unregisterStageHandle = input.stageRegistry.register(handle);

		input.activeStore.recordStageStart(input.runId, stageSnapshot);
		if (input.opts.onStageStart) {
			runSynchronousCallback(
				{ kind: "workflow.stage_adapter", name: `onStageStart:${name}`, runId: input.runId, stageId },
				() => input.opts.onStageStart!(input.runId, stageSnapshot),
			);
		}
		const blockedBy = input.scheduler.blockingAncestorFor(stageSnapshot);
		if (blockedBy !== undefined) input.scheduler.blockStageUntilCascadeRelease(stageSnapshot, blockedBy);

		// Parallel fail-fast and workflow-exit cleanup can both target a live stage.
		// The first terminal path owns the snapshot: finalization unregisters
		// workflow-exit cleanup and removes the stage from the fail-fast active set.
		// Later paths must not overwrite the terminal skippedReason; they only abort
		// and release idempotent live handles.
		const skipForParallelFailFast = async (): Promise<void> => {
			if (isTerminalStage(stageSnapshot)) return;
			markSkippedForParallelFailFast();
			innerCtx.__sealGeneration(true);
			await innerCtx.abort().catch(() => {});
			await innerCtx.__closeGeneration(true);
			await finalizeStageSnapshot();
			await dropStageControlForCompletion().catch(() => {});
		};
		stageFailFastScope?.activeStages.set(stageId, { skip: skipForParallelFailFast });
		runtime.unregisterWorkflowExitCleanup = input.exit.registerWorkflowExitCleanup(stageId, {
			async skipForWorkflowExit(reason?: string): Promise<void> {
				state.stageClosedByWorkflowExit = true;
				innerCtx.__sealGeneration(true);
				await innerCtx.abort().catch(() => {});
				await innerCtx.__closeGeneration(true);
				if (!isTerminalStage(stageSnapshot)) {
					stageSnapshot.status = "skipped";
					stageSnapshot.skippedReason = input.exit.workflowExitSkippedReason(reason);
					await finalizeStageSnapshot();
				}
				await releaseLiveHandle().catch(() => {});
			},
		});

		const runTrackedStageCall = createTrackedStageCaller({
			runtime,
			limiter: input.limiter,
			options,
			adapters: input.adapters,
			hasContinuation: input.opts.continuation !== undefined,
			hasScopedParents: stageFailFastScope?.parentIds !== undefined,
		});
		const context = createStageContext({ runtime, runTrackedStageCall });
		unreachableStageContexts.register(
			context,
			releaseWhenUnreachable(state, input.stageRegistry, input.runId, stageId),
			state,
		);
		input.stageResidency?.add(stageId, {
			evictionState: () => {
				if (waitRecordMissing) return "busy";
				const evictionState = innerCtx.__evictionState();
				return evictionState === "passive" && state.callsInFlight > 0 ? "busy" : evictionState;
			},
			waitingOn: () => {
				const waiting = innerCtx.__waitingOn();
				if (waiting === undefined) return undefined;
				const session: ReleasedAgentSession = {
					sessionId: waiting.sessionId,
					cwd: stageWorkingDirectory(stageSnapshot) ?? input.workflowInvocationCwd,
					...(stageSnapshot.sessionFile === undefined ? {} : { sessionFile: stageSnapshot.sessionFile }),
				};
				return { calls: waiting.calls, session };
			},
			evict: () => {
				unreachableStageContexts.unregister(state);
				runtime.unregisterStageHandle();
			},
		});
		return context;
	};
}

/**
 * A stage context the workflow body dropped can never prompt its stage again, so its completed stage gives its live
 * session back while the run goes on, as every stage does when the run ends. A stage still running when its context
 * is dropped is released when it completes.
 */
const unreachableStageContexts = new FinalizationRegistry<() => void>((release) => release());

/**
 * Built outside the stage factory's scope on purpose: a closure created there would share its scope, and so hold the
 * stage's session for as long as the finalization registry holds the closure.
 */
function releaseWhenUnreachable(
	state: LiveStageMutableState,
	registry: StageControlRegistry,
	runId: string,
	stageId: string,
): () => void {
	return () => {
		state.contextUnreachable = true;
		void registry.releaseIdle(runId, stageId);
	};
}
