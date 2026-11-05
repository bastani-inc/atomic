import type { DurableReleasedStageResume } from "../../durable/types.js";
import type { EngineStageRuntimeOptions } from "../../engine/options.js";
import type { RunBudgetController } from "../../engine/run-budget.js";
import type { StageUiBroker } from "../../shared/stage-ui-broker.js";
import type { Store } from "../../shared/store.js";
import type { StageNotice, StageSnapshot } from "../../shared/store-types.js";
import type { StageContext } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import type { StageScheduler } from "./executor-scheduler.js";
import type { ParallelFailFastScope, StageSessionCheckpointOptions } from "./executor-types.js";
import type { StageAbortListeners } from "./stage-abort-listeners.js";
import type { StageControlRegistry } from "./stage-control-registry.js";
import type { InternalStageContext, LiveInternalStageContext } from "./stage-runner.js";

export interface StageMcpScope {
	apply(): void;
	clear(): void;
}

export type ResumeContinuationReason = "resume" | "queued-user-message" | "paused-queued-user-message";

export interface LiveStageMutableState {
	activeAskUserQuestionAnonymousCalls: number;
	askUserQuestionObservedThisTurn: boolean;
	chatAnswerObservedThisTurn: boolean;
	resumeContinuationPending: false | ResumeContinuationReason;
	suppressQueuedUserMessageContinuation: boolean;
	/** Transient readiness attempt, cancelled by stage pause without aborting the stage lifetime. */
	readinessController?: AbortController;
	readinessPauseVersion?: number;
	/** The user's latest message to this stage (a steer, a typed chat answer, a follow-up) not yet judged for readiness. */
	latestUserMessage?: string;
	/** Counts user messages delivered through stage control; a readiness verdict reached before the latest is discarded. */
	userMessageSeq: number;
	waitingForStageChatTurn: boolean;
	/** Wakes the executor so a paused idle stage-chat can drain released work. */
	wakeWaitingForStageChatTurn: (() => void) | undefined;
	liveHandleReleased: boolean;
	stageClosedByWorkflowExit: boolean;
	stageFinalized: boolean;
	/** True once the stage's final session checkpoint and terminal record were saved without error. */
	sessionCheckpointed: boolean;
	skippedForParallelFailFast: boolean;
	stageControlDropped: boolean;
	/** The workflow body can no longer reach this stage's context, so the stage is released once it completes. */
	contextUnreachable: boolean;
	/** The run admission slot of the stage's current call: held, given back while the stage waits, or none. */
	limiterSlot: "none" | "held" | "released";
	/** Calls of the stage (`prompt`, `complete`, `sendUserMessage`) that finished; recorded with each wait. */
	promptsCompleted: number;
	/** Calls of the stage still running, the readiness question after a turn included. */
	callsInFlight: number;
}

export interface LiveStageRuntime {
	readonly runId: string;
	readonly stageId: string;
	readonly name: string;
	readonly stageSnapshot: StageSnapshot;
	readonly innerCtx: LiveInternalStageContext;
	readonly activeStore: Store;
	readonly opts: EngineStageRuntimeOptions;
	readonly stageRegistry: StageControlRegistry;
	readonly stageUiBroker: StageUiBroker;
	readonly scheduler: StageScheduler;
	readonly signal: AbortSignal;
	readonly exit: WorkflowExitManager;
	readonly budget: RunBudgetController;
	readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
	readonly mcpScope: StageMcpScope;
	readonly stageFailFastScope?: ParallelFailFastScope;
	readonly state: LiveStageMutableState;
	/** The stage's listeners on the run's abort signal, detached while it waits released. */
	readonly abortListeners: StageAbortListeners;
	unregisterStageHandle: () => void;
	dropStageControlHandle: () => void;
	unregisterWorkflowExitCleanup: () => void;
	readonly captureStageSessionMeta: (options?: StageSessionCheckpointOptions) => Promise<void>;
	readonly startStageSessionHeartbeat: () => void;
	readonly drainStageSessionHeartbeat: () => Promise<void>;
	readonly raceStageSessionHeartbeat: <T>(work: Promise<T>) => Promise<T>;
	readonly applyModelFallbackMeta: (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>) => void;
	readonly appendStageStartOnce: () => Promise<void>;
	readonly finalizeStageSnapshot: () => Promise<boolean>;
	readonly releaseLiveHandle: () => Promise<void>;
	readonly dropStageControlForCompletion: () => Promise<void>;
	readonly markSkippedForParallelFailFast: () => void;
	readonly parallelFailFastError: () => unknown;
	readonly throwIfStageMutationBlocked: () => void;
	/**
	 * A durably resumed stage answers its next call from the run's record when that call finished before the previous
	 * process stopped: resolves to the recorded result (none for a replayed message). Undefined when the call runs live.
	 */
	readonly replayRecordedCall: () => Promise<DurableReleasedStageResume["recorded"]> | undefined;
	/** Start the stage released, as its previous process left it waiting between turns. */
	readonly resumeReleased: (resume: DurableReleasedStageResume) => void;
	/**
	 * Wait for the answer to the stage's readiness question; one that outlasts the stage's threshold waits with the
	 * session released, and the session is reopened when the answer arrives.
	 */
	readonly awaitPromptAnswer: <T>(answer: Promise<T>) => Promise<T>;
	/** The stage's last call ended: the run's idle scan starts counting its threshold from now. */
	readonly watchIdle: () => void;
	/** Nothing will use the stage again, so the run's idle scan stops watching it. */
	readonly stopIdleWatch: () => void;
}

export type StageContextWithMeta = StageContext &
	Pick<InternalStageContext, "__modelFallbackMeta"> & {
		/**
		 * Releases the stage's live session once it is completed, saved and unused, as the end of its run does. Only a
		 * caller that keeps no further use of this context may call it; a released stage reopens on demand.
		 */
		readonly __releaseIfIdle?: () => Promise<void>;
		/** Start a durably resumed stage released, as its previous process left it waiting between turns. */
		readonly __resumeReleased?: (resume: DurableReleasedStageResume) => void;
	};

export type StageNoticeInput = Omit<StageNotice, "id" | "ts">;
