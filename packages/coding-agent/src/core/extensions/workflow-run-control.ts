import type { WorkflowRunStatus, WorkflowStageStatus } from "./workflow-events.js";

export type WorkflowRunJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkflowRunJsonValue[]
	| WorkflowRunJsonObject;

export interface WorkflowRunJsonObject {
	readonly [key: string]: WorkflowRunJsonValue | undefined;
}

export type WorkflowRunFilterStatus = WorkflowRunStatus | WorkflowStageStatus | "awaiting_input";

export interface WorkflowRunListFilter {
	/** Run statuses match directly; `awaiting_input` selects runs with an unanswered prompt. */
	readonly status?: WorkflowRunFilterStatus;
}

export interface WorkflowStageListFilter {
	readonly status?: WorkflowStageStatus;
}

export interface WorkflowRunActiveStage {
	readonly stageId: string;
	readonly name: string;
	readonly status: WorkflowStageStatus;
}

export interface WorkflowRunAwaitingInput {
	readonly stageId?: string;
	readonly stageName?: string;
	readonly promptId?: string;
	readonly promptKind?: string;
	readonly message?: string;
}

/** The concise per-run data that the `workflow` tool's `status` action lists. */
export interface WorkflowRunSummary {
	readonly runId: string;
	readonly name: string;
	readonly status: WorkflowRunStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly elapsedMs: number;
	readonly activeStages: readonly WorkflowRunActiveStage[];
	readonly awaitingInputCount: number;
	readonly awaitingInput: readonly WorkflowRunAwaitingInput[];
	readonly exitReason?: string;
	readonly error?: string;
}

export interface WorkflowRunStageSummary {
	readonly id: string;
	readonly name: string;
	readonly status: WorkflowStageStatus;
	readonly sessionId?: string;
	readonly error?: string;
	readonly skippedReason?: string;
	readonly awaitingInputSince?: number;
}

/** The per-run detail that the `workflow` tool's `status` action returns for one run id. */
export interface WorkflowRunDetail {
	readonly runId: string;
	readonly rootRunId?: string;
	readonly name: string;
	readonly status: WorkflowRunStatus | "crashed";
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	readonly inputs: WorkflowRunJsonObject;
	readonly stages: readonly WorkflowRunStageSummary[];
	readonly result?: WorkflowRunJsonObject;
	readonly error?: string;
	readonly exitReason?: string;
	readonly resumable?: boolean;
	readonly resumeGuidance?: string;
	readonly ownerActiveElsewhere?: boolean;
}

export interface WorkflowRunAllTarget {
	readonly all: true;
}

export interface WorkflowRunPauseOptions {
	/** Pause one stage instead of the whole run. */
	readonly stageId?: string;
}

export interface WorkflowRunResumeOptions {
	/** Resume one paused stage instead of the whole run. */
	readonly stageId?: string;
	/** Message delivered to each resumed stage. */
	readonly message?: string;
	readonly legacyRecovery?: { readonly olderWorkersStopped: true };
}

export type WorkflowRunControlStatus = "ok" | "running" | "paused" | "partial" | "noop" | "cancelled";

/** A run that a batch pause or quit could not stop; it may still be active. */
export interface WorkflowRunControlFailedRun {
	readonly runId: string;
	/** Machine-readable refusal, such as `not_found`, `no_active_stages` or `pause_failed`. */
	readonly reason: string;
	readonly message?: string;
}

/**
 * The acknowledged result of a pause, quit or resume request, as the `workflow`
 * tool reports it. `runId` is `--all` for a batch request. `noop` means the request was
 * understood and found nothing to change; `partial` means only part of the
 * request took effect. For a batch pause or quit, `failedRuns` names every run that
 * could not be stopped, so a `partial` outcome is never a complete stop.
 */
export interface WorkflowRunControlOutcome {
	readonly action: "pause" | "quit" | "resume";
	readonly runId: string;
	readonly status: WorkflowRunControlStatus;
	readonly message: string;
	readonly stageId?: string;
	readonly workflowStatus?: WorkflowRunStatus;
	readonly abandoned?: boolean;
	readonly failedRuns?: readonly WorkflowRunControlFailedRun[];
}

/** Typed run management for the workflow runs owned by one session. */
export interface SessionWorkflows {
	listRuns(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunSummary[]>;
	getRun(runId: string): Promise<WorkflowRunDetail>;
	getStages(runId: string, filter?: WorkflowStageListFilter): Promise<readonly WorkflowRunStageSummary[]>;
	pause(runId: string, options?: WorkflowRunPauseOptions): Promise<WorkflowRunControlOutcome>;
	pause(target: WorkflowRunAllTarget): Promise<WorkflowRunControlOutcome>;
	quit(target: string | WorkflowRunAllTarget): Promise<WorkflowRunControlOutcome>;
	resume(runId: string, options?: WorkflowRunResumeOptions): Promise<WorkflowRunControlOutcome>;
}

export interface WorkflowRunControlRegistration {
	dispose(): void;
}

export type WorkflowRunControlErrorCode =
	| "WORKFLOW_RUN_NOT_FOUND"
	| "WORKFLOW_RUN_OWNED_ELSEWHERE"
	| "WORKFLOW_RUN_NOT_RESUMABLE"
	| "WORKFLOW_STAGE_NOT_FOUND"
	| "WORKFLOW_STAGE_AMBIGUOUS"
	| "WORKFLOW_STAGE_RESUME_UNSUPPORTED"
	| "WORKFLOW_RUN_DATABASE"
	| "WORKFLOW_RUN_CONTROL_FAILED"
	| "WORKFLOW_RUN_CONTROL_UNAVAILABLE";

export interface WorkflowRunControlErrorOptions extends ErrorOptions {
	readonly runId?: string;
	readonly failedRuns?: readonly WorkflowRunControlFailedRun[];
}

/** Base class for every failure reported by {@link SessionWorkflows}; branch on `code`. */
export class WorkflowRunControlError extends Error {
	readonly code: WorkflowRunControlErrorCode;
	readonly runId?: string;
	/** Runs a batch pause or quit could not stop, when the whole batch was refused. */
	readonly failedRuns?: readonly WorkflowRunControlFailedRun[];

	constructor(code: WorkflowRunControlErrorCode, message: string, options: WorkflowRunControlErrorOptions = {}) {
		super(message, options);
		this.name = "WorkflowRunControlError";
		this.code = code;
		if (options.runId !== undefined) this.runId = options.runId;
		if (options.failedRuns !== undefined) this.failedRuns = options.failedRuns;
	}
}

/** The run id is unknown, malformed, or an ambiguous prefix. */
export class WorkflowRunNotFoundError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_RUN_NOT_FOUND", message, options);
		this.name = "WorkflowRunNotFoundError";
	}
}

/** The run belongs to another session or is executing in another live Atomic process. */
export class WorkflowRunOwnershipError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_RUN_OWNED_ELSEWHERE", message, options);
		this.name = "WorkflowRunOwnershipError";
	}
}

/** The run has no continuation to resume: it completed, was killed, or has no durable progress. */
export class WorkflowRunNotResumableError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_RUN_NOT_RESUMABLE", message, options);
		this.name = "WorkflowRunNotResumableError";
	}
}

/** The stage identifier matches no stage or tool node of the run. */
export class WorkflowStageNotFoundError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_STAGE_NOT_FOUND", message, options);
		this.name = "WorkflowStageNotFoundError";
	}
}

/** The stage identifier matches more than one stage or tool node; pass a more specific identifier. */
export class WorkflowStageAmbiguousError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_STAGE_AMBIGUOUS", message, options);
		this.name = "WorkflowStageAmbiguousError";
	}
}

/** A durable run can only be resumed whole; resume it without a stage identifier. */
export class WorkflowStageResumeUnsupportedError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_STAGE_RESUME_UNSUPPORTED", message, options);
		this.name = "WorkflowStageResumeUnsupportedError";
	}
}

/** Workflow durability (the run database) is unavailable, shut down, or failed. */
export class WorkflowRunDatabaseError extends WorkflowRunControlError {
	constructor(message: string, options?: WorkflowRunControlErrorOptions) {
		super("WORKFLOW_RUN_DATABASE", message, options);
		this.name = "WorkflowRunDatabaseError";
	}
}

/** The workflows extension is not loaded for this session, or the session was disposed. */
export class WorkflowRunControlUnavailableError extends WorkflowRunControlError {
	constructor(
		message = "Workflow run control is unavailable for this session.",
		options?: WorkflowRunControlErrorOptions,
	) {
		super("WORKFLOW_RUN_CONTROL_UNAVAILABLE", message, options);
		this.name = "WorkflowRunControlUnavailableError";
	}
}
