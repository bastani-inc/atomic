/**
 * How many finished tasks one task owner (a session or a workflow stage) keeps listed and readable. The native task
 * supervisor evicts the oldest finished tasks beyond it, in the order they finished (#4385).
 */
export const FINISHED_TASK_RETENTION = 256;

/** Stable codes of {@link TaskEvictedError}. */
export type TaskEvictedErrorCode = "task_evicted";

/** The facts a {@link TaskEvictedError} carries. */
export interface TaskEvictedErrorFields {
	/** The id the caller named. */
	readonly taskId: string;
	/** Finished tasks each owner keeps; the task was older than all of them. */
	readonly retainedFinishedTasks?: number;
}

const TASK_EVICTED_ERROR_NAME = "TaskEvictedError";
const TASK_EVICTED_ERROR_CODE: TaskEvictedErrorCode = "task_evicted";

function evictionHint(retainedFinishedTasks: number): string {
	return `Only the ${retainedFinishedTasks} most recently finished tasks of a session or workflow stage are kept. Its result stays where the conversation reported it and a subagent's transcript stays in its own saved session, but a shell command's full output is no longer available`;
}

/**
 * A task finished and its owner no longer keeps its record: {@link FINISHED_TASK_RETENTION} or more of the owner's
 * tasks finished after it. Unlike an unknown id, it names a task that existed. Its result is not lost, but `/tasks`,
 * `wait`, `kill` and output reads can no longer reach it, and a shell command's full output was deleted with the record.
 * It is not retryable: the record does not come back.
 */
export class TaskEvictedError extends Error {
	override readonly name = TASK_EVICTED_ERROR_NAME;
	readonly code: TaskEvictedErrorCode = TASK_EVICTED_ERROR_CODE;
	readonly retryable = false;
	readonly hint: string;
	readonly taskId: string;
	readonly retainedFinishedTasks: number;

	constructor(fields: TaskEvictedErrorFields, options?: ErrorOptions) {
		const retainedFinishedTasks = fields.retainedFinishedTasks ?? FINISHED_TASK_RETENTION;
		const hint = evictionHint(retainedFinishedTasks);
		super(`Finished task is no longer kept: ${fields.taskId} (${TASK_EVICTED_ERROR_CODE}). ${hint}.`, options);
		this.hint = hint;
		this.taskId = fields.taskId;
		this.retainedFinishedTasks = retainedFinishedTasks;
	}
}

/** True for a {@link TaskEvictedError}, also one from another realm or process that kept its `name` and `code`. */
export function isTaskEvictedError(error: unknown): error is TaskEvictedError {
	if (error instanceof TaskEvictedError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return candidate.name === TASK_EVICTED_ERROR_NAME && candidate.code === TASK_EVICTED_ERROR_CODE;
}

function isRetention(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Rebuilds a {@link TaskEvictedError} from a copy that crossed a process boundary, such as `JSON.stringify(error)`
 * parsed again. A copy without a string `taskId` or a positive integer `retainedFinishedTasks` gives undefined.
 */
export function rehydrateTaskEvictedError(value: unknown): TaskEvictedError | undefined {
	if (!isTaskEvictedError(value)) return undefined;
	const { taskId, retainedFinishedTasks } = value as {
		readonly taskId?: unknown;
		readonly retainedFinishedTasks?: unknown;
	};
	if (typeof taskId !== "string" || !isRetention(retainedFinishedTasks)) return undefined;
	return new TaskEvictedError({ taskId, retainedFinishedTasks });
}
