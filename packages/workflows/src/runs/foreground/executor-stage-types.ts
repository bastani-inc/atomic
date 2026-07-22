import type { StageNotice, StageSnapshot } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import type { StageContext } from "../../shared/types.js";
import type { InternalStageContext } from "./stage-runner.js";
import type { StageControlRegistry } from "./stage-control-registry.js";
import type { ParallelFailFastScope, StageSessionCheckpointOptions } from "./executor-types.js";
import type { StageScheduler } from "./executor-scheduler.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { EngineStageRuntimeOptions } from "../../engine/options.js";

export interface StageMcpScope {
  apply(): void;
  clear(): void;
}

export type ResumeContinuationReason = "resume" | "queued-user-message";

export interface LiveStageMutableState {
  activeAskUserQuestionAnonymousCalls: number;
  askUserQuestionObservedThisTurn: boolean;
  chatAnswerObservedThisTurn: boolean;
  resumeContinuationPending: false | ResumeContinuationReason;
  waitingForStageChatTurn: boolean;
  liveHandleReleased: boolean;
  stageClosedByWorkflowExit: boolean;
  stageFinalized: boolean;
  skippedForParallelFailFast: boolean;
  stageControlDropped: boolean;
}

export interface LiveStageRuntime {
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
  readonly stageSnapshot: StageSnapshot;
  readonly innerCtx: InternalStageContext;
  readonly activeStore: Store;
  readonly opts: EngineStageRuntimeOptions;
  readonly stageRegistry: StageControlRegistry;
  readonly scheduler: StageScheduler;
  readonly signal: AbortSignal;
  readonly exit: WorkflowExitManager;
  readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
  readonly mcpScope: StageMcpScope;
  readonly stageFailFastScope?: ParallelFailFastScope;
  readonly state: LiveStageMutableState;
  unregisterStageHandle: () => void;
  dropStageControlHandle: () => void;
  unregisterWorkflowExitCleanup: () => void;
  readonly captureStageSessionMeta: (options?: StageSessionCheckpointOptions) => unknown;
  readonly applyModelFallbackMeta: (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>) => void;
  readonly appendStageStartOnce: () => void;
  readonly finalizeStageSnapshot: () => Promise<boolean>;
  readonly releaseLiveHandle: () => Promise<void>;
  readonly dropStageControlForCompletion: () => Promise<void>;
  readonly markSkippedForParallelFailFast: () => void;
  readonly parallelFailFastError: () => unknown;
  readonly throwIfStageMutationBlocked: () => void;
}

export type StageContextWithMeta = StageContext & Pick<InternalStageContext, "__modelFallbackMeta">;

export type StageNoticeInput = Omit<StageNotice, "id" | "ts">;
