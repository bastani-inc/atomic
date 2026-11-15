import type { TaskId } from "./contracts.js";

/**
 * How a finished agent task continues when its chat sends it a message: the extension that launched it resumes it in
 * its own session with that message. A task stopped for good, or one the extension no longer knows, is not resumable,
 * and its chat becomes read-only.
 */
export interface TaskResumer {
	/** Why the task cannot take another message, or `undefined` when it can be resumed with one. */
	readOnlyReason(taskId: TaskId): string | undefined;
	/** Resumes the finished task with `message`; a refusal says why. */
	resume(
		taskId: TaskId,
		message: string,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

const resumers = new WeakMap<object, TaskResumer>();

/** Registers how the tasks of `owner` (a task supervisor) resume; returns the unregister. */
export function bindTaskResumer(owner: object, resumer: TaskResumer): () => void {
	resumers.set(owner, resumer);
	return () => {
		if (resumers.get(owner) === resumer) resumers.delete(owner);
	};
}

/** The resumer registered for `owner`, if any. */
export function taskResumer(owner: object): TaskResumer | undefined {
	return resumers.get(owner);
}
