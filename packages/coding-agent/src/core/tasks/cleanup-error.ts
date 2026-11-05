import type { OwnerCloseCause, ResourceFailure, TaskId } from "./contracts.js";

/** Stable codes of {@link TaskCleanupError}. */
export type TaskCleanupErrorCode = "task_cleanup_unconfirmed";

/**
 * What was confirming the cleanup: an owner closing for that cause, a workflow stage pausing its tasks, or a command
 * admission waiting behind permits that unconfirmed cleanup holds.
 */
export type TaskCleanupPhase = OwnerCloseCause | "stage-pause" | "command-admission";

/** A task whose cleanup failed, with each resource it could not confirm was released. */
export interface TaskCleanupFailure {
	readonly taskId: TaskId;
	readonly resources: readonly ResourceFailure[];
}

const TASK_CLEANUP_ERROR_NAME = "TaskCleanupError";
const TASK_CLEANUP_ADMISSION_TIMEOUT_ERROR_NAME = "TaskCleanupAdmissionTimeoutError";
const TASK_CLEANUP_PHASES: ReadonlySet<string> = new Set<TaskCleanupPhase>([
	"session-close",
	"stage-close",
	"app-shutdown",
	"stage-pause",
	"command-admission",
]);
const TASK_CLEANUP_ERROR_CODE: TaskCleanupErrorCode = "task_cleanup_unconfirmed";
const TASK_CLEANUP_ERROR_NAMES: ReadonlySet<string> = new Set([
	TASK_CLEANUP_ERROR_NAME,
	TASK_CLEANUP_ADMISSION_TIMEOUT_ERROR_NAME,
]);
const TASK_CLEANUP_HINT =
	"Check that the listed processes have exited, then retry or resume the work; the task results are kept";

function failureSubject(failures: readonly TaskCleanupFailure[]): string {
	const resources = failures.flatMap((failure) =>
		failure.resources.map((resource) => `${failure.taskId} ${resource.resource}: ${resource.message}`),
	);
	return resources.length > 0 ? resources.join("; ") : "owned tasks";
}

/**
 * The process cleanup of an owner's tasks could not be confirmed: a process group outlived its kill, or a process
 * outside the group kept a command's output open, past the bound that confirms cleanup. The tasks' results already
 * settled; only releasing their processes is unconfirmed, so the work that closed or paused the owner may be retried.
 */
export class TaskCleanupError extends Error {
	override readonly name: string = TASK_CLEANUP_ERROR_NAME;
	readonly code: TaskCleanupErrorCode = TASK_CLEANUP_ERROR_CODE;
	readonly retryable = true;
	readonly hint = TASK_CLEANUP_HINT;
	readonly phase: TaskCleanupPhase;
	readonly failures: readonly TaskCleanupFailure[];

	constructor(phase: TaskCleanupPhase, failures: readonly TaskCleanupFailure[], options?: ErrorOptions) {
		super(
			`Task cleanup was not confirmed: ${failureSubject(failures)} (${TASK_CLEANUP_ERROR_CODE}). ${TASK_CLEANUP_HINT}.`,
			options,
		);
		this.phase = phase;
		this.failures = failures;
	}
}

/** The wait a command admission gave up on, and how long it had lasted when it did. */
export interface TaskCleanupAdmissionTiming {
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

/**
 * A command's process admission gave up after `timeoutMs` because the owner's own commands still held process permits
 * for cleanup that was not confirmed: such a permit stays held until its cleanup is confirmed or the owner closes, so
 * the wait could have no end. It keeps the family's `code`, told apart by its `name` and its `phase`, `command-admission`.
 * The command never started, and no permit was taken or released on its account.
 * `failures` names the tasks holding permits when the wait ended. `cause` is the admission's own rejection when it
 * rejected with something other than the abort that ended the wait; otherwise there is none. A copy that crossed a
 * process boundary does not carry it.
 */
export class TaskCleanupAdmissionTimeoutError extends TaskCleanupError {
	override readonly name = TASK_CLEANUP_ADMISSION_TIMEOUT_ERROR_NAME;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(failures: readonly TaskCleanupFailure[], timing: TaskCleanupAdmissionTiming, options?: ErrorOptions) {
		super("command-admission", failures, options);
		this.message = `Command admission timed out after ${timing.elapsedMs} ms (limit ${timing.timeoutMs} ms) behind unconfirmed task cleanup: ${failureSubject(failures)} (${TASK_CLEANUP_ERROR_CODE}). ${TASK_CLEANUP_HINT}.`;
		this.timeoutMs = timing.timeoutMs;
		this.elapsedMs = timing.elapsedMs;
	}
}

/** True for a {@link TaskCleanupError}, also one from another realm that kept its `name` and `code`. */
export function isTaskCleanupError(error: unknown): error is TaskCleanupError {
	if (error instanceof TaskCleanupError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return (
		candidate.code === TASK_CLEANUP_ERROR_CODE &&
		typeof candidate.name === "string" &&
		TASK_CLEANUP_ERROR_NAMES.has(candidate.name)
	);
}

/** True for a {@link TaskCleanupAdmissionTimeoutError}, also one from another realm that kept its `name` and `code`. */
export function isTaskCleanupAdmissionTimeoutError(error: unknown): error is TaskCleanupAdmissionTimeoutError {
	if (error instanceof TaskCleanupAdmissionTimeoutError) return true;
	return isTaskCleanupError(error) && error.name === TASK_CLEANUP_ADMISSION_TIMEOUT_ERROR_NAME;
}

function isResourceFailure(value: unknown): value is ResourceFailure {
	const candidate = value as {
		readonly resource?: unknown;
		readonly code?: unknown;
		readonly message?: unknown;
	} | null;
	return (
		typeof candidate?.resource === "string" &&
		typeof candidate.code === "string" &&
		typeof candidate.message === "string"
	);
}

function isDuration(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTaskCleanupFailure(value: unknown): value is TaskCleanupFailure {
	const candidate = value as { readonly taskId?: unknown; readonly resources?: unknown } | null;
	return (
		typeof candidate?.taskId === "string" &&
		Array.isArray(candidate.resources) &&
		candidate.resources.every(isResourceFailure)
	);
}

/**
 * Rebuilds a {@link TaskCleanupError} from a copy that crossed a process boundary, such as `JSON.stringify(error)`
 * parsed again. A copy without a known `phase` or with malformed `failures` gives undefined.
 */
export function rehydrateTaskCleanupError(value: unknown): TaskCleanupError | undefined {
	if (!isTaskCleanupError(value)) return undefined;
	const { name, phase, failures, timeoutMs, elapsedMs } = value as {
		readonly name?: unknown;
		readonly phase?: unknown;
		readonly failures?: unknown;
		readonly timeoutMs?: unknown;
		readonly elapsedMs?: unknown;
	};
	if (!Array.isArray(failures) || !failures.every(isTaskCleanupFailure)) return undefined;
	if (name === TASK_CLEANUP_ADMISSION_TIMEOUT_ERROR_NAME)
		return phase === "command-admission" && isDuration(timeoutMs) && isDuration(elapsedMs)
			? new TaskCleanupAdmissionTimeoutError(failures, { timeoutMs, elapsedMs })
			: undefined;
	if (!TASK_CLEANUP_PHASES.has(phase as TaskCleanupPhase)) return undefined;
	return new TaskCleanupError(phase as TaskCleanupPhase, failures);
}

const MAX_CAUSE_DEPTH = 8;

/**
 * True when the error, or one in its `cause` chain within eight links, is a retryable {@link TaskCleanupError}, also
 * a copy from another process. It does not look inside an `AggregateError`'s `errors`, which may hold failures that
 * are not retryable.
 */
export function isRetryableTaskError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isTaskCleanupError(current) && (current as { readonly retryable?: unknown }).retryable === true) return true;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return false;
}
