/*
 * Type-only package authoring surface for standalone workflow packages.
 *
 * package.json points the root "types" condition here so authors can import
 * workflow without pulling the Atomic runtime/extension graph into their
 * TypeScript program. Runtime loading still uses src/index.ts. Import Type from
 * typebox directly.
 */

import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { TSchema } from "typebox";
import type {} from "./authoring/typebox-defaults.js";

export type {
	EmitSubscriptionEvent,
	EventSource,
	EventSourcePhase,
	GitHubCommandRunner,
	GitHubPullRequestSourceOptions,
	LogTailOptions,
	ScheduledWake,
	SerializedSubscriptionError,
	SerializedSubscriptionErrorCause,
	SourceTimingOptions,
	SubscriberUnavailableReason,
	Subscription,
	SubscriptionAdmission,
	SubscriptionClosedOperation,
	SubscriptionConfigReason,
	SubscriptionErrorCode,
	SubscriptionErrorFields,
	SubscriptionErrorFieldValue,
	SubscriptionErrorName,
	SubscriptionEvent,
	SubscriptionEventPayload,
	SubscriptionEventReason,
	SubscriptionRate,
	SubscriptionRecordKind,
	SubscriptionSetupMissing,
	SubscriptionStats,
	SubscriptionTimeoutPhase,
	WakeDispatcher,
	WebhookEventSource,
	WebhookOptions,
	WebhookRequestFailures,
} from "@bastani/atomic";
export {
	type BoundWorkspace,
	captureWorktreeSnapshot,
	createWakeDispatcher,
	type DecisionAnswerFor,
	type DecisionAnswers,
	type DecisionBoolAnswer,
	type DecisionBoolQuestion,
	type DecisionChoiceAnswer,
	type DecisionChoiceQuestion,
	DecisionConfigError,
	type DecisionConfigErrorCode,
	DecisionError,
	type DecisionErrorCode,
	DecisionModelUnavailableError,
	type DecisionModelUnavailableReason,
	DecisionOutputError,
	type DecisionPhase,
	DecisionProviderError,
	type DecisionQuestion,
	type DecisionQuestions,
	type DecisionRequest,
	DecisionRequestError,
	type DecisionRequestErrorReason,
	type DecisionResult,
	type DecisionScoreAnswer,
	type DecisionScoreQuestion,
	type DecisionSource,
	DecisionTimeoutError,
	decide,
	deserializeSubscriptionError,
	EventSourceError,
	findDecisionError,
	findSubscriptionError,
	findWorkspaceError,
	GitUnavailableError,
	type GitUnavailableErrorCode,
	githubChecks,
	githubReviews,
	interval,
	isBoundWorkspace,
	isDecisionConfigError,
	isDecisionError,
	isDecisionModelUnavailableError,
	isDecisionOutputError,
	isDecisionProviderError,
	isDecisionRequestError,
	isDecisionTimeoutError,
	isEventSourceError,
	isGitUnavailableError,
	isRetryableDecisionError,
	isRetryableSubscriptionError,
	isRetryableWorkspaceError,
	isSubscriptionChildUnavailableError,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionError,
	isSubscriptionEventError,
	isSubscriptionHandlerError,
	isSubscriptionRecordError,
	isSubscriptionSetupError,
	isSubscriptionSubscriberUnavailableError,
	isSubscriptionTimeoutError,
	isWorkspace,
	isWorkspaceBindingError,
	isWorkspaceCollectionError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceError,
	isWorkspaceGitError,
	isWorkspacePublicationError,
	isWorkspaceRestoreError,
	isWorkspaceSandboxError,
	isWorkspaceSnapshotError,
	isWorkspaceTimeoutError,
	logTail,
	type PublishedPullRequest,
	type PublishPullRequestOptions,
	parseSerializedDecisionError,
	publishEvent,
	publishPullRequest,
	rehydrateDecisionError,
	rehydrateWorkspaceError,
	resolveWorkspace,
	restoreWorkspace,
	restoreWorktreeSnapshot,
	type SerializedDecisionError,
	type SerializedWorkspaceError,
	SUBSCRIPTION_REPORT_TOOL_NAME,
	SubscriptionChildUnavailableError,
	SubscriptionClosedError,
	SubscriptionConfigError,
	SubscriptionError,
	SubscriptionEventError,
	SubscriptionHandlerError,
	SubscriptionRecordError,
	SubscriptionSetupError,
	SubscriptionSubscriberUnavailableError,
	SubscriptionTimeoutError,
	serializeDecisionError,
	serializeSubscriptionError,
	serializeWorkspaceError,
	sharedWakeDispatcher,
	verifyWorktree,
	type Workspace,
	type WorkspaceBinding,
	WorkspaceBindingError,
	type WorkspaceBindingErrorCode,
	type WorkspaceBindingErrorReason,
	type WorkspaceChangeSet,
	WorkspaceCollectionError,
	type WorkspaceCollectionErrorCode,
	WorkspaceConfigError,
	type WorkspaceConfigErrorCode,
	type WorkspaceConfigErrorReason,
	type WorkspaceConfigSource,
	type WorkspaceDiffStat,
	WorkspaceDriftError,
	type WorkspaceDriftErrorCode,
	WorkspaceError,
	type WorkspaceErrorCode,
	type WorkspaceErrorFields,
	WorkspaceGitError,
	type WorkspaceGitErrorCode,
	type WorkspaceGitPhase,
	type WorkspaceOptions,
	WorkspacePublicationError,
	type WorkspacePublicationErrorCode,
	type WorkspacePublicationErrorReason,
	WorkspaceRestoreError,
	type WorkspaceRestoreErrorCode,
	type WorkspaceRestoreErrorReason,
	type WorkspaceSandbox,
	WorkspaceSandboxError,
	type WorkspaceSandboxErrorCode,
	WorkspaceSnapshotError,
	type WorkspaceSnapshotErrorCode,
	WorkspaceTimeoutError,
	type WorkspaceTimeoutErrorCode,
	type WorktreeBinding,
	type WorktreeRootMapping,
	type WorktreeSnapshot,
	type WorktreeSnapshotSettingsInput,
	webhook,
	workspace,
	workspaceChangeSet,
} from "@bastani/atomic";
export type { Static, TSchema } from "typebox";
export type {
	ObserveRunJournalRead,
	OpenRunJournal,
	RunJournalConformanceRunner,
	RunJournalReadObservation,
} from "./durable/journal/conformance.js";
export { registerRunJournalConformance } from "./durable/journal/conformance.js";
export { MemoryRunJournal } from "./durable/journal/memory-run-journal.js";
export type { RunJournalOption, RunJournalSettings } from "./durable/journal/resolution.js";
export { resolveRunJournal } from "./durable/journal/resolution.js";
export { openSqlRunJournal, SqlRunJournal } from "./durable/journal/sqlite-run-journal.js";
export * from "./durable/journal/types.js";
export type { WorkflowSnapshotBoundary } from "./shared/worktree-snapshot-contract.js";
export declare function listWorkflowSnapshotBoundaries(
	journal: import("@bastani/atomic/storage").RunJournal,
	runId: string,
): Promise<readonly import("./shared/worktree-snapshot-contract.js").WorkflowSnapshotBoundary[]>;
export declare function workflowSnapshotFrontier(
	boundaries: readonly import("./shared/worktree-snapshot-contract.js").WorkflowSnapshotBoundary[],
): readonly import("./shared/worktree-snapshot-contract.js").WorkflowSnapshotBoundary[];

export type {
	AgentSessionAdapter,
	CompleteAdapter,
	CompleteStageOpts,
	EffectiveBudget,
	GitWorktreeSetupOptions,
	GitWorktreeSetupResult,
	PromptAdapter,
	PromptOptions,
	ResolvedInputs,
	RunFailureClassification,
	RunResult,
	RunStatus,
	StageAdapters,
	StageContext,
	StageExecutionMeta,
	StageMcpOptions,
	StageOptions,
	StageOutputOptions,
	StagePromptOptions,
	StageSendUserMessageOptions,
	StageSessionCreateOptions,
	StageSessionCreateResult,
	StageSessionEvent,
	StageSessionRuntime,
	StageSnapshot,
	StageStatus,
	StageUserMessageContent,
	StageUserMessageDelivery,
	StageWorktreeSnapshot,
	ToolNodeSnapshot,
	WorkflowAction,
	WorkflowArtifact,
	WorkflowBudget,
	WorkflowChainOptions,
	WorkflowChildResult,
	WorkflowContextMode,
	WorkflowControlEvent,
	WorkflowCustomToolDefinition,
	WorkflowCustomUiComponent,
	WorkflowCustomUiFactory,
	WorkflowCustomUiKeybindings,
	WorkflowCustomUiOptions,
	WorkflowCustomUiOverlayHandle,
	WorkflowCustomUiOverlayOptions,
	WorkflowCustomUiTheme,
	WorkflowCustomUiTui,
	WorkflowDetails,
	WorkflowDetailsMode,
	WorkflowDetailsStatus,
	WorkflowEventChild,
	WorkflowEventHandler,
	WorkflowEventPrimitives,
	WorkflowEventStream,
	WorkflowEventSubscriber,
	WorkflowEventsOptions,
	WorkflowExecutionMode,
	WorkflowExecutionPolicy,
	WorkflowExitOptions,
	WorkflowExitStatus,
	WorkflowInputBindings,
	WorkflowInputSchema,
	WorkflowInputSchemaMap,
	WorkflowInputValues,
	WorkflowIntercomSummary,
	WorkflowMaxOutput,
	WorkflowMcpPort,
	WorkflowModelAttempt,
	WorkflowModelCatalogPort,
	WorkflowModelFallbackFields,
	WorkflowModelInfo,
	WorkflowModelUsage,
	WorkflowModelValue,
	WorkflowOutputMode,
	WorkflowOutputSchema,
	WorkflowOutputSchemaMap,
	WorkflowOutputValues,
	WorkflowParallelFailure,
	WorkflowParallelOptions,
	WorkflowPersistencePort,
	WorkflowProgressSummary,
	WorkflowProviderRateLimit,
	WorkflowRunChildArgs,
	WorkflowRunChildOptions,
	WorkflowRunChildOptionsArgument,
	WorkflowRunOutput,
	WorkflowRuntimeConfig,
	WorkflowSerializableObject,
	WorkflowSerializablePrimitive,
	WorkflowSerializableValue,
	WorkflowSharedTaskDefaults,
	WorkflowSubscribeOptions,
	WorkflowSubscription,
	WorkflowTaskContext,
	WorkflowTaskContextInput,
	WorkflowTaskOptions,
	WorkflowTaskResult,
	WorkflowTaskSessionFields,
	WorkflowTaskSessionOptions,
	WorkflowTaskStep,
	WorkflowThinkingLevel,
	WorkflowToolContext,
	WorkflowToolError,
	WorkflowToolFailure,
	WorkflowToolOptions,
	WorkflowToolOutcome,
	WorkflowToolPrimitive,
	WorkflowToolReturnOptions,
	WorkflowToolSuccess,
	WorkflowToolThrowOptions,
	WorkflowUIAdapter,
	WorkflowUIContext,
	WorkflowWorktreeInputBinding,
} from "./shared/authoring-contract.js";

import type { RunJournalOption } from "./durable/journal/resolution.js";
import type * as AuthoringContract from "./shared/authoring-contract.js";
import type { WorkflowForkedFrom } from "./shared/fork-lineage.js";
import type { StageWake, StageWakeDelivery } from "./shared/stage-wake.js";
import type {
	AuthoredWorkflowSpec as SharedAuthoredWorkflowSpec,
	WorkflowInputsFromSchemas,
	WorkflowOutputsFromSchemas,
	WorkflowProvidedInputsFromSchemas,
} from "./shared/workflow-authoring-types.js";

export type {
	WorkflowInputsFromSchemas,
	WorkflowOutputsFromSchemas,
	WorkflowProvidedInputsFromSchemas,
} from "./shared/workflow-authoring-types.js";
export type {
	WorkflowHeartbeatEvent,
	WorkflowHeartbeatEventDetails,
	WorkflowHeartbeatIdentity,
} from "./shared/workflow-heartbeat-contract.js";

import type {
	GitWorktreeSetupOptions,
	GitWorktreeSetupResult,
	ResolvedInputs,
	RunResult,
	RunStatus,
	StageSnapshot,
	WorkflowDefinition as WorkflowContractDefinition,
	WorkflowExecutionPolicy,
	WorkflowInputSchemaMap,
	WorkflowInputValues,
	WorkflowOutputSchemaMap,
	WorkflowOutputValues,
	WorkflowSerializableObject,
} from "./shared/authoring-contract.js";

// Type-only nominal brand for standalone package typings. Runtime discovery uses
// the package-internal WeakSet in authoring/workflow.ts rather than a symbol field.
declare const workflowDefinitionBrand: unique symbol;
type WorkflowDefinitionBrand = { readonly [workflowDefinitionBrand]: true };

export interface WorkflowDefinition<
	TInputs extends WorkflowInputValues = WorkflowInputValues,
	TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
	TDefinitionBrand extends object = WorkflowDefinitionBrand,
> extends WorkflowContractDefinition<TInputs, TOutputs, TRunInputs, TDefinitionBrand>,
		WorkflowDefinitionBrand {}

export type AuthoredWorkflowDefinition<
	TInputs extends WorkflowInputSchemaMap,
	TOutputs extends WorkflowOutputSchemaMap,
> = WorkflowDefinition<
	WorkflowInputsFromSchemas<TInputs>,
	WorkflowOutputsFromSchemas<TOutputs>,
	WorkflowProvidedInputsFromSchemas<TInputs>
> & {
	readonly outputs: Readonly<TOutputs>;
};

export type WorkflowRunContext<
	TInputs extends WorkflowInputValues = WorkflowInputValues,
	TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunContext<TInputs, WorkflowDefinitionBrand, TOutputs>;
export type WorkflowRunFn<
	TInputs extends WorkflowInputValues = WorkflowInputValues,
	TOutputs extends WorkflowOutputValues = WorkflowOutputValues,
> = AuthoringContract.WorkflowRunFn<TInputs, TOutputs, WorkflowDefinitionBrand>;

type WorkflowRunInputArgument<TInputs extends WorkflowInputValues> = [keyof TInputs] extends [never]
	? Readonly<Record<string, never>>
	: TInputs;

export type AuthoredWorkflowSpec<
	TInputs extends WorkflowInputSchemaMap = Record<never, never>,
	TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
	TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
> = SharedAuthoredWorkflowSpec<
	TInputs,
	TOutputs,
	TActualOutputs,
	WorkflowRunContext<WorkflowInputsFromSchemas<TInputs>, WorkflowOutputsFromSchemas<TOutputs>>
>;

export type AnyWorkflowDefinition = WorkflowDefinition<WorkflowInputValues, WorkflowOutputValues, WorkflowInputValues>;

export type RunContinuationOpts = AuthoringContract.RunContinuationOpts;
export type WorkflowParentRunLink = AuthoringContract.WorkflowParentRunLink;
export type RunOpts = Omit<AuthoringContract.RunOpts, "registry"> & { readonly registry?: WorkflowRegistry };

export declare const INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare const NON_INTERACTIVE_WORKFLOW_POLICY: WorkflowExecutionPolicy;
export declare function run<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(
	definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>,
	inputs: Readonly<NoInfer<WorkflowRunInputArgument<TRunInputs>>>,
	opts?: RunOpts,
): Promise<RunResult<TOutputs>>;
export type {
	EvictWhenWaiting,
	ReleaseWhenWaiting,
	StageLifecycleEvent,
	StageWaitKind,
	StageWaitSnapshot,
	StageWaitToolCall,
} from "./shared/authoring-contract-stage.js";
export type {
	ErrorFamily,
	SerializedError,
	SerializedErrorField,
	SerializedErrorFields,
	SerializedWorkflowInfrastructureError,
} from "./shared/error-codec.js";
export {
	rehydrateError,
	rehydrateWorkflowInfrastructureError,
	serializeError,
	serializeWorkflowInfrastructureError,
} from "./shared/error-codec.js";
export type {
	PossibleStagePredictionErrorCode,
	PossibleStagePredictionPhase,
	StageDecisionAnswerErrorReason,
} from "./shared/possible-stage-prediction-errors.js";
export {
	findPossibleStagePredictionError,
	isPossibleStagePredictionError,
	isStageDecisionAnswerError,
	isStageDecisionFailedError,
	isStageDecisionTimeoutError,
	isStageDecisionUnavailableError,
	POSSIBLE_STAGE_PREDICTION_THRESHOLDS,
	PossibleStagePredictionError,
	StageDecisionAnswerError,
	StageDecisionFailedError,
	StageDecisionTimeoutError,
	StageDecisionUnavailableError,
} from "./shared/possible-stage-prediction-errors.js";
export type {
	LocalWorkerOptionsErrorCode,
	LocalWorkerOptionsErrorReason,
	LocalWorkerOptionsSource,
	LocalWorkerPoolErrorCode,
	LocalWorkerPoolErrorOptions,
	LocalWorkerTimingOption,
	PoolNotInitializedFields,
	PoolProtocolFields,
	PublicationRejectedFields,
	PublicationRejectedReason,
	StaleWorkLeaseFields,
	StaleWorkLeaseReason,
	WorkAttemptFencedFields,
} from "./shared/worker-pool-errors.js";
export {
	causedByStaleWorkLease,
	findLocalWorkerPoolError,
	isLocalWorkerOptionsError,
	isLocalWorkerPoolError,
	isPoolNotInitializedError,
	isPoolProtocolError,
	isPublicationRejectedError,
	isStaleWorkLeaseError,
	isWorkAttemptFencedError,
	LocalWorkerOptionsError,
	LocalWorkerPoolError,
	PoolNotInitializedError,
	PoolProtocolError,
	PublicationRejectedError,
	StaleWorkLeaseError,
	WorkAttemptFencedError,
} from "./shared/worker-pool-errors.js";
export type {
	SerializedWorkflowGitRequiredError,
	WorkflowGitRequiredFields,
	WorkflowGitRequiredSource,
} from "./shared/workflow-git-required-error.js";
export {
	isWorkflowGitRequiredError,
	rehydrateWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "./shared/workflow-git-required-error.js";
/** Milliseconds a stage waits on a tool call inline before it releases its session, unless configured otherwise. */
export declare const DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS: 60000;
/** The largest `releaseWhenWaiting.afterMs`, 2³¹−1 ms (about 24.8 days): the longest delay a timer honours. */
export declare const MAX_RELEASE_WHEN_WAITING_AFTER_MS: 2147483647;
/** Milliseconds a run only waits on detached tool calls before `evictWhenWaiting: true` evicts it. */
export declare const DEFAULT_EVICT_WHEN_WAITING_AFTER_MS: 60000;
export type {
	RunEvictedErrorCode,
	RunEvictionConfigErrorCode,
	RunEvictionConfigReason,
	RunEvictionConfigSource,
	RunEvictionErrorCode,
	RunEvictionErrorFields,
	RunReplayErrorCode,
	SerializedRunEvictionError,
} from "./shared/run-eviction-errors.js";
export {
	deserializeRunEvictionError,
	findRunEvictionError,
	isRunEvictedError,
	isRunEvictionConfigError,
	isRunEvictionError,
	isRunReplayError,
	RunEvictedError,
	RunEvictionConfigError,
	RunEvictionError,
	RunReplayError,
} from "./shared/run-eviction-errors.js";
export type {
	SerializedErrorCause,
	SerializedStageWaitError,
	StageRehydrationErrorCode,
	StageReleasedErrorCode,
	StageReleasedProperty,
	StageWaitConfigSource,
	StageWaitErrorCode,
	StageWaitErrorFields,
	StageWaitPhase,
	StageWaitRecordPhase,
	StageWakeErrorCode,
	StageWakeRegistrationErrorCode,
} from "./shared/stage-wait-errors.js";
export {
	deserializeStageWaitError,
	findStageWaitError,
	isStageRehydrationError,
	isStageReleasedError,
	isStageReleaseError,
	isStageWaitConfigError,
	isStageWaitError,
	isStageWaitRecordError,
	isStageWakeError,
	StageRehydrationError,
	StageReleasedError,
	StageReleaseError,
	StageWaitConfigError,
	StageWaitError,
	StageWaitRecordError,
	StageWakeError,
} from "./shared/stage-wait-errors.js";
export type {
	BuiltinStageWakeKind,
	StageWake,
	StageWakeDelivery,
	StageWakeHandler,
	StageWakeHandlerContext,
	StageWakeKinds,
} from "./shared/stage-wake.js";
export { registerStageWakeKind } from "./shared/stage-wake.js";
export type {
	SerializedWorkflowStructuredOutputInferenceError,
	WorkflowStructuredOutputInferenceErrorCode,
	WorkflowStructuredOutputInferenceErrorFields,
} from "./shared/structured-output-errors.js";
export {
	deserializeWorkflowStructuredOutputInferenceError,
	findWorkflowStructuredOutputInferenceError,
	isWorkflowStructuredOutputInferenceError,
	WorkflowStructuredOutputInferenceError,
} from "./shared/structured-output-errors.js";
/**
 * Send a message to a stage of a live run in this process. Throws `StageWakeError` (`unknown-wake-kind`) when no
 * module registered the message's kind; otherwise returns what became of it.
 */
export declare function deliverStageWake(runId: string, stageId: string, wake: StageWake): StageWakeDelivery;
export type {
	AdmissionHolderStoppedFields,
	ProcessCleanupResource,
	QuarantinedCapacityFields,
	WorkerCleanupUnconfirmedFields,
	WorkerLostFields,
	WorkerRetryLimitFields,
	WorkerRetryLimitReason,
	WorkerStartupFields,
	WorkerStartupTimeoutFields,
	WorkflowInfrastructureErrorOptions,
	WorkflowInfrastructureFault,
} from "./shared/workflow-infrastructure-error.js";
export {
	AdmissionHolderStoppedError,
	isAdmissionHolderStoppedError,
	isProcessCleanupUnconfirmedError,
	isQuarantinedCapacityError,
	isRetryableWorkflowError,
	isWorkerCleanupUnconfirmedError,
	isWorkerLostError,
	isWorkerRetryLimitError,
	isWorkerStartupError,
	isWorkerStartupTimeoutError,
	isWorkflowInfrastructureError,
	ProcessCleanupUnconfirmedError,
	QuarantinedCapacityError,
	WorkerCleanupUnconfirmedError,
	WorkerLostError,
	WorkerRetryLimitError,
	WorkerStartupError,
	WorkerStartupTimeoutError,
	WorkflowInfrastructureError,
} from "./shared/workflow-infrastructure-error.js";
export declare function loadWorkerWorkflow(path: string, exportName?: string): Promise<AnyWorkflowDefinition>;
export * from "./durable/fork-errors.js";
export type {
	SharedPoolFailure,
	SharedPoolFleet,
	SharedPoolFleetController,
	SharedPoolFleetStatus,
	SharedPoolHost,
	SharedPoolHostReport,
	SharedPoolHostState,
	SharedPoolRateLimit,
	SharedPoolScaleEvent,
	SharedPoolStats,
	SharedStoreHealth,
	WorkerHostGitSource,
} from "./durable/journal/shared-pool-types.js";
export {
	READINESS_DECISION_THRESHOLDS,
	type ReadinessDecisionThresholds,
	type ReadinessOutcome,
	type ReadinessProbabilities,
	type ReadinessVerdict,
	readinessVerdict,
	type StageReadinessDecision,
} from "./runs/foreground/readiness-decision.js";
export type { WorkflowDecisionRequest } from "./shared/authoring-contract-stage.js";
export type {
	DurableRepositoryBinding,
	DurableWorkspaceBinding,
	WorkflowForkedFrom,
} from "./shared/fork-lineage.js";
export type {
	WorkflowAdmissionConfigErrorCode,
	WorkflowAdmissionErrorCode,
	WorkflowAdmissionMismatchReason,
	WorkflowAdmissionSource,
} from "./workers/admission-errors.js";
export {
	findWorkflowAdmissionError,
	isWorkflowAdmissionConfigError,
	isWorkflowAdmissionError,
	WorkflowAdmissionConfigError,
	WorkflowAdmissionError,
} from "./workers/admission-errors.js";
export type {
	RemoteStageCommand,
	SerializedWorkerPlacementError,
	SharedPoolOperation,
	SharedPoolSetupErrorCode,
	SharedPoolSetupProblem,
	StageInputIdentity,
	StageInputInvalidReason,
	StageInputRefusedReason,
	StageInputTimeoutPhase,
	StaleStageLeaseReason,
	WorkerPlacementConfigErrorCode,
	WorkerPlacementConfigSource,
	WorkerPlacementErrorCode,
	WorkspaceBindingIdentity,
	WorkspaceRestoreUnavailableReason,
} from "./workers/placement-errors.js";
export {
	isRemoteStageCommandUnsupportedError,
	isRetryableWorkerPlacementError,
	isSharedPoolSetupError,
	isStageInputInvalidError,
	isStageInputRefusedError,
	isStageInputTimeoutError,
	isStaleStageLeaseError,
	isWorkerPlacementConfigError,
	isWorkerPlacementError,
	isWorkspaceRestoreUnavailableError,
	RemoteStageCommandUnsupportedError,
	rehydrateWorkerPlacementError,
	SharedPoolSetupError,
	StageInputInvalidError,
	StageInputRefusedError,
	StageInputTimeoutError,
	StaleStageLeaseError,
	serializeWorkerPlacementError,
	WorkerPlacementConfigError,
	WorkerPlacementError,
	WorkspaceRestoreUnavailableError,
} from "./workers/placement-errors.js";
export type {
	LocalWorkerOptions,
	WorkflowAdmissionOptions,
	WorkflowWorkerPlacementOptions,
} from "./workers/public-options.js";
export type { PooledStageInputKind } from "./workers/stage-input-kind.js";
export declare const DEFAULT_PLACEMENT_CLAIM_WINDOW_MS: number;
export type {
	SharedJournalSelection,
	WorkerHostFailure,
	WorkerHostGit,
	WorkflowWorkerHost,
	WorkflowWorkerHostEvent,
	WorkflowWorkerHostOptions,
	WorkflowWorkerHostStats,
} from "./workers/worker-host-types.js";
/**
 * Joins this host to the shared pools of every root whose pool runs on `options.journal` (#4310): roots started with
 * `workers: { placement: "shared" }` on a journal every host opens through a storage adapter.
 */
export declare function startWorkflowWorkerHost(
	options: import("./workers/worker-host-types.js").WorkflowWorkerHostOptions,
): Promise<import("./workers/worker-host-types.js").WorkflowWorkerHost>;
/**
 * The worker hosts registered in a shared journal and the pool stats of the running or paused roots they serve, with the
 * fleet's queue and the shared store's state (#4768). Default journal: the one this machine selects for workflow runs.
 * Setup problems reject; a store that cannot be read, or does not answer within 5 s, resolves with `fleet.store.state`
 * `"unknown"` instead.
 */
export declare function readWorkflowWorkerFleet(options?: {
	readonly journal?: import("./workers/worker-host-types.js").SharedJournalSelection;
	readonly agentDir?: string;
}): Promise<import("./durable/journal/shared-pool-types.js").SharedPoolFleet>;
/**
 * A fleet that {@link readWorkflowWorkerFleet} read, as `atomic worker status` prints it (#4768): the shared store when
 * it is not ok, with a hint to recover it, the fleet's queue, each host with its state, and each root's queue.
 */
export declare function workflowWorkerFleetLines(
	fleet: import("./durable/journal/shared-pool-types.js").SharedPoolFleet,
): string[];
export type {
	ProvisionedHost,
	WorkerFleetPolicyOptions,
	WorkerHostProvisioner,
	WorkflowFleetController,
	WorkflowFleetControllerOptions,
	WorkflowFleetEvent,
	WorkflowFleetFailure,
	WorkflowFleetOptions,
	WorkflowFleetStatus,
} from "./workers/fleet-types.js";
/**
 * Starts a fleet controller on a shared journal (#4768): it adds worker hosts through `options.provisioner` as the
 * queues of the journal's shared roots grow, and drains and removes idle ones. One controller of a journal is active at
 * a time. Default journal: the one this machine selects for workflow runs.
 */
export declare function startWorkflowFleetController(
	options: import("./workers/fleet-types.js").WorkflowFleetControllerOptions,
): Promise<import("./workers/fleet-types.js").WorkflowFleetController>;
export type {
	AzureVmssProvisionerOptions,
	CommandProvisionerOptions,
	KubernetesProvisionerOptions,
	WorkerHostProvisionerConfig,
	WorkerProvisionerErrorCode,
} from "./workers/provisioners/types.js";
/**
 * A built-in worker host provisioner (#4768), after checking its options: `azure-vmss` drives `az vmss`, `kubernetes`
 * drives `kubectl` on a Deployment or StatefulSet, and `command` runs your own up, down and list commands. Each uses its
 * CLI's own credentials, and a failed call rejects with a {@link WorkerProvisionerError}.
 */
export declare function createWorkerHostProvisioner(
	config: import("./workers/provisioners/types.js").WorkerHostProvisionerConfig,
): import("./workers/fleet-types.js").WorkerHostProvisioner;
/** A built-in provisioner's CLI call that failed (#4768). Its message never carries the CLI's arguments or secrets. */
export declare class WorkerProvisionerError extends Error {
	readonly name: "WorkerProvisionerError";
	readonly code: import("./workers/provisioners/types.js").WorkerProvisionerErrorCode;
	/** The CLI's exit code, when it exited. */
	readonly exitCode?: number;
}
export type {
	RestoredWorkspace,
	WorkspaceHookOptions,
	WorkspacePreference,
	WorkspaceRestore,
} from "./workers/workspace-binding.js";

/** Which Intercom messages and prompt answers a fork carries: those before the fork point (default) or all. */
export type ForkCarryMessages = "before" | "all";

/** A completed stage a run can be forked from. */
export interface ForkPoint {
	/** Dot path of the stage: enclosing nested-workflow stage names, then the stage name. */
	readonly stagePath: string;
	/** Agent session the stage ran in, when it ran one. */
	readonly sessionId?: string;
	/** The entry that session continues from (its leaf), for `forkFromEntryId`. */
	readonly entryId?: string;
	readonly completedAt: number;
}

/** One notification of a run, as `run()` reports it through its `on*` callbacks. */
export type WorkflowRunEvent =
	| { readonly type: "run_start"; readonly run: RunSnapshot }
	| { readonly type: "stage_start"; readonly runId: string; readonly stage: StageSnapshot }
	| { readonly type: "stage_end"; readonly runId: string; readonly stage: StageSnapshot }
	| {
			readonly type: "stage_session_event";
			readonly runId: string;
			readonly stageId: string;
			readonly event: import("@bastani/atomic").AgentSessionEvent;
	  }
	| {
			readonly type: "run_end";
			readonly runId: string;
			readonly status: RunStatus;
			readonly result?: WorkflowOutputValues;
			readonly error?: string;
			readonly exitReason?: string;
	  };

export interface ForkRunOptions<TDefinition = AnyWorkflowDefinition>
	extends Omit<RunOpts, "runId" | "continuation" | "parentRun" | "cwd"> {
	/** Dot path of the stage to re-run from (see `listForkPoints`). Omitted: the fork copies the whole run. */
	readonly fromStage?: string;
	/** Replacement inputs, validated against the definition. Omitted: the source run's inputs. */
	readonly inputs?: WorkflowInputValues;
	/** Directory the fork runs in. Omitted: the source run's directory. */
	readonly cwd?: string;
	/** Intercom messages and prompt answers to carry: those before the fork point (default) or all. */
	readonly carryMessages?: ForkCarryMessages;
	/** The workflow definition. Omitted: the registry option, then the workflows discovered for the source's directory. */
	readonly definition?: TDefinition;
	/** Session store holding the source run's stage sessions. Omitted: the source project's store. */
	readonly sourceSessionStore?: import("@bastani/atomic").SessionStore;
}

/** A forked run. `events` yields the run's notifications once, in order; `result` settles when the run ends. */
export interface ForkedRun {
	readonly runId: string;
	readonly forkedFrom: WorkflowForkedFrom;
	readonly events: AsyncIterable<WorkflowRunEvent>;
	readonly result: Promise<RunResult>;
}

export interface ListForkPointsOptions {
	readonly journal?: RunJournalOption;
	readonly store?: Store;
	readonly cwd?: string;
	/** Session store holding the run's stage sessions, read for each point's `entryId`. Omitted: the run's project store. */
	readonly sourceSessionStore?: import("@bastani/atomic").SessionStore;
}

/**
 * Fork a durable run from a stage into a new run and execute it; the source run is never written. Every
 * precondition is checked before anything is copied, and failures are `ForkError`s.
 */
export declare function forkRun<
	TInputs extends WorkflowInputValues,
	TOutputs extends WorkflowOutputValues,
	TRunInputs extends WorkflowInputValues = TInputs,
>(runId: string, options?: ForkRunOptions<WorkflowDefinition<TInputs, TOutputs, TRunInputs>>): Promise<ForkedRun>;
/** The completed stages of a durable run, in completion order, that `forkRun` can fork from. Read-only. */
export declare function listForkPoints(runId: string, options?: ListForkPointsOptions): AsyncIterable<ForkPoint>;
/**
 * Build the default stage-session adapter: each stage runs an in-process Atomic
 * `createAgentSession` session. `baseOptions` apply to every stage; stage options
 * override them. Each stage gets its own session manager, in-memory unless the
 * stage sets `sessionDir` or resumes or forks a session.
 */
export declare function createAgentSessionAdapter(
	baseOptions?: Omit<CreateAgentSessionOptions, "sessionManager">,
): AuthoringContract.AgentSessionAdapter;
export declare function resolveInputs<TInputs extends WorkflowInputValues>(
	schema: Readonly<Record<keyof TInputs & string, TSchema>>,
	provided: Partial<TInputs>,
): ResolvedInputs<TInputs>;
export declare function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult;

export interface WorkflowRegistry {
	register<
		TInputs extends WorkflowInputValues,
		TOutputs extends WorkflowOutputValues,
		TRunInputs extends WorkflowInputValues = TInputs,
	>(definition: WorkflowDefinition<TInputs, TOutputs, TRunInputs>): WorkflowRegistry;
	merge(other: WorkflowRegistry): WorkflowRegistry;
	get(name: string): AnyWorkflowDefinition | undefined;
	has(name: string): boolean;
	remove(name: string): WorkflowRegistry;
	names(): string[];
	all(): AnyWorkflowDefinition[];
}

export declare function workflow<
	const TInputs extends WorkflowInputSchemaMap = Record<never, never>,
	const TOutputs extends WorkflowOutputSchemaMap = WorkflowOutputSchemaMap,
	TActualOutputs extends WorkflowOutputsFromSchemas<TOutputs> = WorkflowOutputsFromSchemas<TOutputs>,
>(spec: AuthoredWorkflowSpec<TInputs, TOutputs, TActualOutputs>): AuthoredWorkflowDefinition<TInputs, TOutputs>;

/**
 * Wrap prompt text so compaction protects it verbatim, regardless of the compression ratio.
 *
 * Reserve it for text whose loss silently changes behavior: role constraints, acceptance
 * criteria and immutable contracts, explicit prohibitions, and identifiers a stage must not
 * lose. Do not wrap bulk context — protected lines count against the keep target rather than
 * raising it, so a large span makes the surrounding transcript compress harder.
 */
export declare function keepContext(text: string): string;
export declare const KEEP_CONTEXT_OPEN_TAG: string;
export declare const KEEP_CONTEXT_CLOSE_TAG: string;
export declare const DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES: 15;
export declare const WORKFLOW_HEARTBEAT_CUSTOM_TYPE: "workflows:workflow-heartbeat";
export declare function createRegistry<
	TDefinitions extends readonly AnyWorkflowDefinition[] = readonly AnyWorkflowDefinition[],
>(initial?: TDefinitions): WorkflowRegistry;
export declare function normalizeWorkflowName(name: string): string;
export declare function workflowNamesEqual(a: string, b: string): boolean;

export declare class GraphFrontierTracker {
	onSpawn(stageId: string, stageName: string): string[];
	currentParents(): string[];
	replaceParents(stageId: string, parentIds: readonly string[]): void;
	detach(stageId: string): void;
	onSettle(stageId: string): void;
	getNodes(): StageNode[];
	getParents(stageId: string): string[];
	reset(): void;
}
export interface StageNode extends WorkflowSerializableObject {
	readonly id: string;
	readonly name: string;
	readonly parentIds: readonly string[];
}
export type NoticeLevel = "info" | "warning" | "error";
export type PromptKind = "input" | "confirm" | "select" | "editor" | "custom";
export type CustomPromptIdentitySource = "caller" | "factory" | "callsite";

export interface PendingPrompt extends WorkflowSerializableObject {
	readonly id: string;
	readonly kind: PromptKind;
	readonly message: string;
	readonly choices?: readonly string[];
	readonly initial?: string;
	readonly customIdentityHash?: string;
	readonly customIdentitySource?: CustomPromptIdentitySource;
	readonly createdAt: number;
}

export interface ToolEvent {
	readonly name: string;
	readonly input?: Record<string, unknown>;
	readonly output?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
}

export interface WorkflowNotice extends WorkflowSerializableObject {
	readonly id: string;
	readonly runId?: string;
	readonly stageId?: string;
	readonly level: NoticeLevel;
	readonly message: string;
	readonly createdAt: number;
	readonly requiresAck?: boolean;
	readonly ackedAt?: number;
}

export interface WorkflowOverlayAdapter {
	show(notice: WorkflowNotice): void;
	hide(): void;
}

export interface RunSnapshot {
	readonly id: string;
	readonly name: string;
	readonly status: RunStatus;
	readonly stages: readonly StageSnapshot[];
	/** First-class durable ctx.tool nodes; populated by the runtime. */
	readonly toolNodes: readonly import("./shared/authoring-contract.js").ToolNodeSnapshot[];
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	readonly result?: WorkflowOutputValues;
	readonly error?: string;
	/** Tool node whose rejection supplied the selected terminal failure. */
	readonly failedToolNodeId?: string;
	/** True when the run reached its terminal status through ctx.exit(). */
	readonly exited?: boolean;
	readonly exitReason?: string;
	readonly pendingPrompt?: PendingPrompt;
	/** Source run and stage when the run was created by `forkRun`. */
	readonly forkedFrom?: WorkflowForkedFrom;
}

export interface StoreSnapshot {
	readonly runs: readonly RunSnapshot[];
	readonly notices: readonly WorkflowNotice[];
	readonly version: number;
}

export interface Store {
	runs(): readonly RunSnapshot[];
	notices(): readonly WorkflowNotice[];
	activeRunId(): string | null;
	recordRunStart(run: RunSnapshot): void;
	recordStageStart(runId: string, stage: StageSnapshot): void;
	recordToolStart(runId: string, stageId: string, evt: ToolEvent): void;
	recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void;
	recordStageEnd(runId: string, stage: StageSnapshot): void;
	recordRunEnd(runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string): boolean;
	removeRun(runId: string): boolean;
	recordNotice(notice: WorkflowNotice): void;
	ackNotice(id: string): boolean;
	/** JSON copy of every run and notice at the current store version. */
	snapshot(): StoreSnapshot;
	/** Cached, payload-bounded projection for graph rendering; one object per store version. */
	graphSnapshot(): StoreSnapshot;
	/** Calls `listener` with a fresh `snapshot()` after each store change. Returns an unsubscribe function. */
	subscribe(listener: (snapshot: StoreSnapshot) => void): () => void;
}

export declare function createStore(): Store;
export declare const store: Store;

export interface ActiveRunEntry {
	readonly controller: AbortController;
	readonly children: readonly AbortController[];
}

export interface CancellationRegistry {
	register(runId: string, controller: AbortController): void;
	registerChild(runId: string, controller: AbortController): void;
	abort(runId: string, reason?: unknown): boolean;
	abortAll(reason?: unknown): number;
	unregister(runId: string): void;
	isAborted(runId: string): boolean;
}

export declare function createCancellationRegistry(): CancellationRegistry;
export declare const cancellationRegistry: CancellationRegistry;
