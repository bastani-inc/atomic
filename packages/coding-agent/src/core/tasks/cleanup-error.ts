import type { OwnerCloseCause, ResourceFailure, TaskId } from "./contracts.js";

/** Stable codes of {@link TaskCleanupError}. */
export type TaskCleanupErrorCode = "task_cleanup_unconfirmed";

/** What was confirming the cleanup: an owner closing for that cause, or a workflow stage pausing its tasks. */
export type TaskCleanupPhase = OwnerCloseCause | "stage-pause";

/** A task whose cleanup failed, with each resource it could not confirm was released. */
export interface TaskCleanupFailure {
	readonly taskId: TaskId;
	readonly resources: readonly ResourceFailure[];
}

const TASK_CLEANUP_ERROR_NAME = "TaskCleanupError";
const TASK_CLEANUP_PHASES: ReadonlySet<string> = new Set<TaskCleanupPhase>([
	"session-close",
	"stage-close",
	"app-shutdown",
	"stage-pause",
]);
const TASK_CLEANUP_ERROR_CODE: TaskCleanupErrorCode = "task_cleanup_unconfirmed";
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
	override readonly name = TASK_CLEANUP_ERROR_NAME;
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

/** True for a {@link TaskCleanupError}, also one from another realm that kept its `name` and `code`. */
export function isTaskCleanupError(error: unknown): error is TaskCleanupError {
	if (error instanceof TaskCleanupError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === TASK_CLEANUP_ERROR_NAME && candidate.code === TASK_CLEANUP_ERROR_CODE;
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
	const { phase, failures } = value as { readonly phase?: unknown; readonly failures?: unknown };
	if (!TASK_CLEANUP_PHASES.has(phase as TaskCleanupPhase)) return undefined;
	if (!Array.isArray(failures) || !failures.every(isTaskCleanupFailure)) return undefined;
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
