import type { ResourceFailure, TaskCleanupError, TaskCleanupPhase } from "@bastani/atomic";
import {
	isStorageTransientError,
	isStorageWriteLockTimeoutError,
	isStorageWriterQueueUnusableError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { causeChain, failureMessage, hasIdentity } from "./error-cause-chain.js";
import { isStageWaitError } from "./stage-wait-errors.js";
import { isLocalWorkerPoolError } from "./worker-pool-errors.js";

export type WorkflowInfrastructureFault =
	| "worker_lost"
	| "worker_cleanup_unconfirmed"
	| "worker_retry_limit"
	| "worker_startup_failed"
	| "stale_work_lease"
	| "intercom_unavailable"
	| "storage_unavailable"
	| "process_cleanup_unconfirmed";

/** Every infrastructure fault, as a stage or run failure records it in `failureCode`. */
export const WORKFLOW_INFRASTRUCTURE_FAULTS: ReadonlySet<string> = new Set<WorkflowInfrastructureFault>([
	"worker_lost",
	"worker_cleanup_unconfirmed",
	"worker_retry_limit",
	"worker_startup_failed",
	"stale_work_lease",
	"intercom_unavailable",
	"storage_unavailable",
	"process_cleanup_unconfirmed",
]);

const FAILURES: Readonly<Record<WorkflowInfrastructureFault, string>> = {
	worker_lost: "Local worker lost",
	worker_cleanup_unconfirmed: "Local worker process cleanup unconfirmed",
	worker_retry_limit: "Local worker retry limit",
	worker_startup_failed: "Local worker startup failed",
	stale_work_lease: "Work attempt is no longer current",
	intercom_unavailable: "Intercom unavailable",
	storage_unavailable: "Storage unavailable",
	process_cleanup_unconfirmed: "Workflow stage task cleanup was not confirmed",
};

const HINTS: Readonly<Record<WorkflowInfrastructureFault, string>> = {
	worker_lost:
		"The pool replays the affected children from their last checkpoints; retry or resume the run if it failed.",
	worker_cleanup_unconfirmed:
		"Resource permits of the surviving process groups stay quarantined until they exit; stop them or restart the host.",
	worker_retry_limit: "Only this child failed; retry it or resume the root once the fault in `cause` is fixed.",
	worker_startup_failed:
		"Read the worker log for the cause; the pool runs no child on a worker that never became ready.",
	stale_work_lease: "The pool replays the child from its last checkpoint under the attempt that owns its work now.",
	intercom_unavailable: "The stage's Intercom runtime ended; a retry or resume connects it again.",
	storage_unavailable: "The workflow journal could not be reached; check the storage it names, then retry or resume.",
	process_cleanup_unconfirmed:
		"Check that the stage's task processes have exited, then resume the run or retry the work; the stage's results are kept.",
};

export interface WorkflowInfrastructureErrorOptions extends ErrorOptions {
	/** What failed, as the message names it; the run and stage by default. */
	readonly subject?: string;
	readonly hint?: string;
	/** The run that failed on the fault, when known. */
	readonly runId?: string;
	/** The stage that failed on the fault, when known. */
	readonly stageId?: string;
	/** A cleanup that failed after the fault, kept beside it rather than as its cause. */
	readonly cleanupCause?: Error;
}

/**
 * A retryable fault of the workflow runtime rather than of the workflow's own logic: the local worker pool, its
 * workers, Intercom or storage. Catch it, or test with {@link isRetryableWorkflowError}, to retry a child; `code` says
 * which fault it was and each concrete subclass carries the fault's facts.
 */
export class WorkflowInfrastructureError extends Error {
	override readonly name: string = "WorkflowInfrastructureError";
	readonly retryable = true as const;
	readonly code: WorkflowInfrastructureFault;
	readonly hint: string;
	readonly runId?: string;
	readonly stageId?: string;
	declare readonly cleanupCause?: Error;

	constructor(code: WorkflowInfrastructureFault, options: WorkflowInfrastructureErrorOptions = {}) {
		const { subject, hint = HINTS[code], runId, stageId, cause, cleanupCause } = options;
		const where =
			subject ??
			(runId === undefined ? "the workflow run" : `run ${runId}${stageId === undefined ? "" : ` stage ${stageId}`}`);
		super(failureMessage(FAILURES[code], where, code, hint), cause === undefined ? undefined : { cause });
		this.code = code;
		this.hint = hint;
		this.runId = runId;
		this.stageId = stageId;
		if (cleanupCause !== undefined) this.cleanupCause = cleanupCause;
	}
}

/** A resource a stage's task cleanup left unconfirmed, with the task that owned it. */
export interface ProcessCleanupResource extends ResourceFailure {
	readonly taskId: string;
}

/**
 * `process_cleanup_unconfirmed`: a stage's task process cleanup was still unconfirmed when the stage closed. The
 * stage's work is done, so retrying it can succeed, and a resume continues the stage from its saved session. The
 * fields and the hint come from the `TaskCleanupError` that is its cause.
 */
export class ProcessCleanupUnconfirmedError extends WorkflowInfrastructureError {
	override readonly name = "ProcessCleanupUnconfirmedError" as const;
	declare readonly code: "process_cleanup_unconfirmed";
	readonly phase: TaskCleanupPhase;
	readonly resources: readonly ProcessCleanupResource[];
	declare readonly cause: TaskCleanupError;

	constructor(cause: TaskCleanupError) {
		const resources = cause.failures.flatMap((failure) =>
			failure.resources.map((resource) => ({ taskId: failure.taskId, ...resource })),
		);
		const subject = resources.length > 0 ? resources.map((resource) => resource.resource).join(", ") : "owned tasks";
		super("process_cleanup_unconfirmed", { subject, hint: cause.hint, cause });
		this.phase = cause.phase;
		this.resources = resources;
	}
}

/** How a message names a process's stderr log, and why the pool could not write it when it could not. */
function logSubject(logPath: string, logFailure: string | undefined): string {
	return logFailure === undefined ? `log ${logPath}` : `log ${logPath} could not be written: ${logFailure}`;
}

export interface WorkerLostFields {
	/** `delivery`: a worker exited before it acknowledged a delivery; `coordinator`: the pool's coordinator exited. */
	readonly phase: "delivery" | "coordinator";
	readonly pid?: number;
	readonly exitCode?: number;
	readonly signal?: string;
	/** The lost process's stderr log, when the pool keeps one: the coordinator's. */
	readonly logPath?: string;
	/** Why that log could not be written, as an error code such as `EACCES`; the process ran without it. */
	readonly logFailure?: string;
}

/** A worker or the pool's coordinator process exited while the pool depended on it. */
export class WorkerLostError extends WorkflowInfrastructureError {
	override readonly name = "WorkerLostError" as const;
	declare readonly code: "worker_lost";
	readonly phase: WorkerLostFields["phase"];
	readonly pid?: number;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly logPath?: string;
	readonly logFailure?: string;

	constructor(fields: WorkerLostFields, options?: ErrorOptions) {
		const process = fields.pid === undefined ? "process" : `process ${fields.pid}`;
		const ended =
			fields.signal !== undefined
				? ` (${fields.signal})`
				: fields.exitCode !== undefined
					? ` (code ${fields.exitCode})`
					: "";
		const log = fields.logPath === undefined ? "" : `, ${logSubject(fields.logPath, fields.logFailure)}`;
		super("worker_lost", {
			...options,
			subject:
				fields.phase === "coordinator"
					? `pool coordinator ${process} exited${ended}${log}`
					: `worker ${process} exited before it acknowledged a delivery${ended}${log}`,
			hint:
				fields.phase === "coordinator"
					? "The pool and its unfinished children failed; read the coordinator's log for why, and resume the root to start a new pool."
					: HINTS.worker_lost,
		});
		this.phase = fields.phase;
		this.pid = fields.pid;
		this.exitCode = fields.exitCode;
		this.signal = fields.signal;
		this.logPath = fields.logPath;
		this.logFailure = fields.logFailure;
	}
}

export interface WorkerStartupFields {
	/** The worker's stderr log. */
	readonly logPath: string;
	/** Why that log could not be written, as an error code such as `EACCES`; the worker ran without it. */
	readonly logFailure?: string;
}

/** A local worker exited before it reported ready. */
export class WorkerStartupError extends WorkflowInfrastructureError {
	override readonly name: string = "WorkerStartupError";
	declare readonly code: "worker_startup_failed";
	readonly logPath: string;
	readonly logFailure?: string;

	constructor(fields: WorkerStartupFields, options?: WorkflowInfrastructureErrorOptions) {
		super("worker_startup_failed", {
			subject: `worker exited before readiness (${logSubject(fields.logPath, fields.logFailure)})`,
			...options,
		});
		this.logPath = fields.logPath;
		this.logFailure = fields.logFailure;
	}
}

export interface WorkerStartupTimeoutFields extends WorkerStartupFields {
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

/** A local worker did not report ready within `localWorkers.startupTimeoutMs`. */
export class WorkerStartupTimeoutError extends WorkerStartupError {
	override readonly name = "WorkerStartupTimeoutError" as const;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase = "startup" as const;

	constructor(fields: WorkerStartupTimeoutFields, options?: ErrorOptions) {
		super(fields, {
			...options,
			subject: `worker not ready after ${fields.timeoutMs} ms (${logSubject(fields.logPath, fields.logFailure)})`,
			hint: "Workers were too slow to start, usually because the machine is busy or the pool is large for its cores. Raise workflows.localWorkers.startupTimeoutMs (localWorkers.startupTimeoutMs in the SDK) to allow more time.",
		});
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
	}
}

/** Why a child, or the pool, ran out of attempts. */
export type WorkerRetryLimitReason = "worker-lost" | "refused-stale" | "pool-fault" | "worker-crashes";

export const WORKER_RETRY_LIMIT_REASONS: readonly WorkerRetryLimitReason[] = [
	"worker-lost",
	"refused-stale",
	"pool-fault",
	"worker-crashes",
];

const RETRY_LIMIT_TEXT: Readonly<Record<WorkerRetryLimitReason, string>> = {
	"worker-lost": "lost its worker",
	"refused-stale": "was refused by the root as stale",
	"pool-fault": "failed on a fault of the pool",
	"worker-crashes": "workers crashed without running a child",
};

export interface WorkerRetryLimitFields {
	/** `worker-crashes` fails the whole pool; every other reason fails one child, named by `childRunId`. */
	readonly reason: WorkerRetryLimitReason;
	readonly attempts: number;
	readonly limit: number;
	readonly childRunId?: string;
	/** The export of the child's worker definition. */
	readonly exportName?: string;
	/** The stderr log of the worker the last attempt ran on. */
	readonly logPath?: string;
	/** Why that log could not be written, as an error code such as `EACCES`; the worker ran without it. */
	readonly logFailure?: string;
}

/** A child lost every attempt it may take in this root incarnation, or the pool's workers kept crashing. */
export class WorkerRetryLimitError extends WorkflowInfrastructureError {
	override readonly name = "WorkerRetryLimitError" as const;
	declare readonly code: "worker_retry_limit";
	readonly reason: WorkerRetryLimitReason;
	readonly attempts: number;
	readonly limit: number;
	readonly childRunId?: string;
	readonly exportName?: string;
	readonly logPath?: string;
	readonly logFailure?: string;

	/** `cause` is the fault that ended the last attempt; `cleanupCause` a cleanup of its worker that failed after it. */
	constructor(
		fields: WorkerRetryLimitFields,
		options?: Pick<WorkflowInfrastructureErrorOptions, "cause" | "cleanupCause">,
	) {
		const pool = fields.reason === "worker-crashes";
		super("worker_retry_limit", {
			...options,
			subject: pool
				? `${fields.attempts} ${RETRY_LIMIT_TEXT[fields.reason]}, over the limit of ${fields.limit}`
				: `child ${fields.childRunId} (${fields.exportName}) ${RETRY_LIMIT_TEXT[fields.reason]} ${fields.attempts} times`,
			...(pool
				? { hint: "The pool stopped because its workers keep crashing; read their logs for the crash." }
				: {}),
			runId: fields.childRunId,
		});
		this.reason = fields.reason;
		this.attempts = fields.attempts;
		this.limit = fields.limit;
		this.childRunId = fields.childRunId;
		this.exportName = fields.exportName;
		this.logPath = fields.logPath;
		this.logFailure = fields.logFailure;
	}
}

export interface WorkerCleanupUnconfirmedFields {
	/** Process groups still running after SIGKILL; empty when only permits of stopped workers are still held. */
	readonly processGroups: readonly number[];
}

/** Process groups of stopped workers survived SIGKILL, or their permits could not be released. */
export class WorkerCleanupUnconfirmedError extends WorkflowInfrastructureError {
	override readonly name = "WorkerCleanupUnconfirmedError" as const;
	declare readonly code: "worker_cleanup_unconfirmed";
	readonly processGroups: readonly number[];

	constructor(fields: WorkerCleanupUnconfirmedFields, options?: ErrorOptions) {
		super("worker_cleanup_unconfirmed", {
			...options,
			subject:
				fields.processGroups.length > 0
					? `process groups ${fields.processGroups.join(", ")} still running after SIGKILL`
					: "permits of stopped workers are still held",
		});
		this.processGroups = [...fields.processGroups];
	}
}

export interface QuarantinedCapacityFields {
	/** Each limit quarantined permits fill, as configured, e.g. `admission.limits.process (1)`. */
	readonly limits: readonly string[];
	readonly processGroups: readonly number[];
	readonly waitedMs: number;
}

/**
 * A process admission refused because, for as long as it may wait, only quarantined permits held the capacity it
 * waited for. A pooled child's attempt ends on it and the child replays within its attempt limit.
 */
export class QuarantinedCapacityError extends WorkflowInfrastructureError {
	override readonly name = "QuarantinedCapacityError" as const;
	declare readonly code: "worker_cleanup_unconfirmed";
	readonly limits: readonly string[];
	readonly processGroups: readonly number[];
	readonly waitedMs: number;

	constructor(fields: QuarantinedCapacityFields, options?: ErrorOptions) {
		super("worker_cleanup_unconfirmed", {
			...options,
			subject: `process permit refused after ${Math.round(fields.waitedMs)} ms: ${fields.limits.join(" and ")} held by quarantined permits of process groups ${fields.processGroups.join(", ")} that survived SIGKILL`,
			hint: "The child replays within its attempt limit; stop those process groups to free their capacity.",
		});
		this.limits = [...fields.limits];
		this.processGroups = [...fields.processGroups];
		this.waitedMs = fields.waitedMs;
	}
}

export interface AdmissionHolderStoppedFields {
	/** The reason recorded on the admission's permit, when there was one. */
	readonly permitReason?: string;
}

/** A waiting admission whose permit the pool released for good: its holder was stopped (worker exit, host reboot). */
export class AdmissionHolderStoppedError extends WorkflowInfrastructureError {
	override readonly name = "AdmissionHolderStoppedError" as const;
	declare readonly code: "stale_work_lease";
	readonly permitReason?: string;

	constructor(fields: AdmissionHolderStoppedFields, options?: ErrorOptions) {
		super("stale_work_lease", {
			...options,
			subject: `the admission holder was stopped${fields.permitReason === undefined ? "" : ` (${fields.permitReason})`}`,
			hint: "The pool stopped the worker that asked; the child replays within its attempt limit.",
		});
		this.permitReason = fields.permitReason;
	}
}

const FAMILY_NAMES: ReadonlySet<string> = new Set([
	"WorkflowInfrastructureError",
	"WorkerLostError",
	"WorkerStartupError",
	"WorkerStartupTimeoutError",
	"WorkerRetryLimitError",
	"WorkerCleanupUnconfirmedError",
	"QuarantinedCapacityError",
	"AdmissionHolderStoppedError",
	"ProcessCleanupUnconfirmedError",
]);

export function isWorkflowInfrastructureError(value: unknown): value is WorkflowInfrastructureError {
	return (
		value instanceof WorkflowInfrastructureError ||
		(hasIdentity(value, FAMILY_NAMES, WORKFLOW_INFRASTRUCTURE_FAULTS) &&
			(value as { readonly retryable?: unknown }).retryable === true)
	);
}

function guard<T extends WorkflowInfrastructureError>(
	type: abstract new (...args: never[]) => T,
	names: readonly string[],
	code: WorkflowInfrastructureFault,
) {
	const nameSet = new Set(names);
	const codes = new Set([code]);
	return (value: unknown): value is T => value instanceof type || hasIdentity(value, nameSet, codes);
}

export const isWorkerLostError = guard(WorkerLostError, ["WorkerLostError"], "worker_lost");
export const isWorkerStartupError = guard(
	WorkerStartupError,
	["WorkerStartupError", "WorkerStartupTimeoutError"],
	"worker_startup_failed",
);
export const isWorkerStartupTimeoutError = guard(
	WorkerStartupTimeoutError,
	["WorkerStartupTimeoutError"],
	"worker_startup_failed",
);
export const isWorkerRetryLimitError = guard(WorkerRetryLimitError, ["WorkerRetryLimitError"], "worker_retry_limit");
export const isWorkerCleanupUnconfirmedError = guard(
	WorkerCleanupUnconfirmedError,
	["WorkerCleanupUnconfirmedError"],
	"worker_cleanup_unconfirmed",
);
export const isQuarantinedCapacityError = guard(
	QuarantinedCapacityError,
	["QuarantinedCapacityError"],
	"worker_cleanup_unconfirmed",
);
export const isAdmissionHolderStoppedError = guard(
	AdmissionHolderStoppedError,
	["AdmissionHolderStoppedError"],
	"stale_work_lease",
);
const isProcessCleanupUnconfirmedIdentity = guard(
	ProcessCleanupUnconfirmedError,
	["ProcessCleanupUnconfirmedError"],
	"process_cleanup_unconfirmed",
);

/** True for a {@link ProcessCleanupUnconfirmedError}, also a copy from another realm that kept its `resources`. */
export function isProcessCleanupUnconfirmedError(value: unknown): value is ProcessCleanupUnconfirmedError {
	return (
		value instanceof ProcessCleanupUnconfirmedError ||
		(isProcessCleanupUnconfirmedIdentity(value) &&
			Array.isArray((value as { readonly resources?: unknown }).resources))
	);
}

function isRetryableStageWaitError(value: object): boolean {
	return isStageWaitError(value) && (value as { readonly retryable?: unknown }).retryable === true;
}

/**
 * Whether a caller may retry: anything in `error`'s cause chain (at most eight levels) is an infrastructure fault, a
 * retryable pool error, or a `StageWaitError` that says so (for example a `StageRehydrationError` with code
 * `session-unavailable`). Structural copies from another process count too.
 */
export function isRetryableWorkflowError(error: unknown): boolean {
	return causeChain(error).some(
		(node) =>
			isWorkflowInfrastructureError(node) ||
			(isLocalWorkerPoolError(node) && node.retryable === true) ||
			isRetryableStageWaitError(node),
	);
}

/**
 * Whether `value` is a storage outage: a `StorageUnavailableError`, its write-lock timeout, unusable writers' queue or
 * transient server failure, or an error from another process, realm or storage layer with one of those identities.
 */
export function isStorageUnavailable(value: object): boolean {
	if (
		value instanceof StorageUnavailableError ||
		isStorageWriteLockTimeoutError(value) ||
		isStorageWriterQueueUnusableError(value) ||
		isStorageTransientError(value)
	)
		return true;
	const { name, adapter, location } = value as {
		readonly name?: unknown;
		readonly adapter?: unknown;
		readonly location?: unknown;
	};
	return name === "StorageUnavailableError" && typeof adapter === "string" && typeof location === "string";
}

/**
 * The infrastructure fault `error` is, by type: the outermost error in its cause chain whose `code` is a
 * {@link WorkflowInfrastructureFault}, or that is a storage outage. Its message is never read.
 */
export function infrastructureFaultOf(error: unknown): WorkflowInfrastructureFault | undefined {
	for (const node of causeChain(error)) {
		const code = (node as { readonly code?: unknown }).code;
		if (typeof code === "string" && WORKFLOW_INFRASTRUCTURE_FAULTS.has(code))
			return code as WorkflowInfrastructureFault;
		if (isStorageUnavailable(node)) return "storage_unavailable";
	}
	return undefined;
}

/**
 * `error` as the {@link WorkflowInfrastructureError} a caller of the pool receives: itself when it is one, a new one
 * caused by it when it is another infrastructure fault ({@link infrastructureFaultOf}), or undefined.
 */
export function workflowInfrastructureErrorFor(error: unknown): WorkflowInfrastructureError | undefined {
	if (isWorkflowInfrastructureError(error)) return error;
	const code = infrastructureFaultOf(error);
	return code === undefined ? undefined : new WorkflowInfrastructureError(code, { cause: error });
}

interface RecordedRun {
	readonly runId?: unknown;
	readonly status?: unknown;
	readonly failure?: unknown;
	readonly stages?: unknown;
}

function recordedFault(value: unknown): WorkflowInfrastructureFault | undefined {
	return typeof value === "string" && WORKFLOW_INFRASTRUCTURE_FAULTS.has(value)
		? (value as WorkflowInfrastructureFault)
		: undefined;
}

/**
 * The infrastructure fault a failed run result failed on, from the codes its classification recorded: its first failed
 * stage with a fault `failureCode`, or else its own `failure.code`. Undefined for any other result.
 */
export function runInfrastructureFault(result: RecordedRun): WorkflowInfrastructureError | undefined {
	if (result.status !== "failed") return undefined;
	const runId = typeof result.runId === "string" ? result.runId : undefined;
	const stages = Array.isArray(result.stages)
		? (result.stages as readonly {
				readonly id?: unknown;
				readonly status?: unknown;
				readonly failureCode?: unknown;
			}[])
		: [];
	for (const stage of stages) {
		const code = stage?.status === "failed" ? recordedFault(stage.failureCode) : undefined;
		if (code !== undefined)
			return new WorkflowInfrastructureError(code, {
				runId,
				stageId: typeof stage.id === "string" ? stage.id : undefined,
			});
	}
	const code = recordedFault((result.failure as { readonly code?: unknown } | null | undefined)?.code);
	return code === undefined ? undefined : new WorkflowInfrastructureError(code, { runId });
}

/** Whether a failed run result failed on a fault of the pool rather than on its own logic. */
export function failedOnPoolFault(result: RecordedRun): boolean {
	return runInfrastructureFault(result) !== undefined;
}
