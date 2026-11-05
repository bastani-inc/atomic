/**
 * Non-cyclic public SDK surface for @bastani/workflows.
 *
 * Keep public runtime exports here when they are safe to load during workflow
 * discovery. The package root re-exports this module directly.
 */

export {
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
	findDecisionError,
	isDecisionConfigError,
	isDecisionError,
	isDecisionModelUnavailableError,
	isDecisionOutputError,
	isDecisionProviderError,
	isDecisionRequestError,
	isDecisionTimeoutError,
	isRetryableDecisionError,
	parseSerializedDecisionError,
	rehydrateDecisionError,
	type SerializedDecisionError,
	serializeDecisionError,
} from "@bastani/atomic";
export type { Static, TSchema } from "typebox";
export { KEEP_CONTEXT_CLOSE_TAG, KEEP_CONTEXT_OPEN_TAG, keepContext } from "./authoring/keep-context.js";
export type {
	AuthoredWorkflowDefinition,
	AuthoredWorkflowSpec,
	WorkflowInputsFromSchemas,
	WorkflowOutputsFromSchemas,
	WorkflowProvidedInputsFromSchemas,
} from "./authoring/workflow.js";
export { workflow } from "./authoring/workflow.js";
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
export type { StageNode } from "./engine/graph-inference.js";
export { GraphFrontierTracker } from "./engine/graph-inference.js";
export { createAgentSessionAdapter } from "./extension/wiring.js";
export type { ActiveRunEntry, CancellationRegistry } from "./runs/background/cancellation-registry.js";
// Phase D — cancellation registry
export { cancellationRegistry, createCancellationRegistry } from "./runs/background/cancellation-registry.js";
export type { ResolvedInputs, RunOpts, RunResult } from "./runs/foreground/executor.js";
export { resolveInputs } from "./runs/foreground/executor.js";
export {
	READINESS_DECISION_THRESHOLDS,
	type ReadinessDecisionThresholds,
	type ReadinessOutcome,
	type ReadinessProbabilities,
	type ReadinessVerdict,
	readinessVerdict,
	type StageReadinessDecision,
} from "./runs/foreground/readiness-decision.js";
export { run } from "./runs/foreground/sdk-run.js";
export type { AgentSessionAdapter, StageAdapters } from "./runs/foreground/stage-runner.js";
export type { GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./runs/shared/worktree.js";
export { setupGitWorktree } from "./runs/shared/worktree.js";
export type { WorkflowDecisionRequest } from "./shared/authoring-contract-stage.js";
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
export { createStore, store } from "./shared/store.js";
export type {
	CustomPromptIdentitySource,
	NoticeLevel,
	PendingPrompt,
	PoolCoordinationCount,
	PoolCoordinationStats,
	PromptKind,
	RunFailureClassification,
	RunPoolSnapshot,
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	StoreSnapshot,
	ToolEvent,
	ToolNodeSnapshot,
	WorkflowNotice,
	WorkflowOverlayAdapter,
} from "./shared/store-types.js";
export type * from "./shared/types.js";
export { INTERACTIVE_WORKFLOW_POLICY, NON_INTERACTIVE_WORKFLOW_POLICY } from "./shared/types.js";
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
export type {
	WorkflowHeartbeatEvent,
	WorkflowHeartbeatEventDetails,
	WorkflowHeartbeatIdentity,
} from "./shared/workflow-heartbeat-contract.js";
export {
	DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES,
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
} from "./shared/workflow-heartbeat-contract.js";
export type {
	ProcessCleanupResource,
	SerializedWorkflowInfrastructureError,
	WorkflowInfrastructureFault,
} from "./shared/workflow-infrastructure-error.js";
export {
	isProcessCleanupUnconfirmedError,
	isRetryableWorkflowError,
	ProcessCleanupUnconfirmedError,
	rehydrateWorkflowInfrastructureError,
	serializeWorkflowInfrastructureError,
	WorkflowInfrastructureError,
} from "./shared/workflow-infrastructure-error.js";
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
export { loadWorkerWorkflow } from "./workers/definitions.js";
export type {
	LocalWorkerOptionsErrorCode,
	LocalWorkerOptionsErrorReason,
	LocalWorkerOptionsSource,
	LocalWorkerPoolErrorCode,
	LocalWorkerTimingOption,
} from "./workers/local-worker-pool-errors.js";
export {
	findLocalWorkerPoolError,
	isLocalWorkerOptionsError,
	isLocalWorkerPoolError,
	LocalWorkerOptionsError,
	LocalWorkerPoolError,
} from "./workers/local-worker-pool-errors.js";
export type { LocalWorkerOptions, WorkflowAdmissionOptions } from "./workers/public-options.js";
export { normalizeWorkflowName, workflowNamesEqual } from "./workflows/identity.js";
export type { WorkflowRegistry } from "./workflows/registry.js";
export { createRegistry } from "./workflows/registry.js";

import "./durable/journal/workflows-host-module.js";
