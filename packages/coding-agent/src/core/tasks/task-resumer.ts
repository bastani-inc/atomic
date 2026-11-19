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
	/**
	 * Stops a running task so that it stays resumable, as `x x` and Ctrl+X Ctrl+K do. `undefined` when this task is not
	 * one the resumer stops, and its owner cancels it as usual.
	 */
	stop?(taskId: TaskId): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> | undefined;
	/** Whether the task was stopped resumably and waits for a message to resume it. */
	isStopped?(taskId: TaskId): boolean;
}

// An extension and its host can load separate SDK modules. Both must see the same owner binding, or a panel stop
// misses the extension's resumable quit and falls back to permanent cancellation.
const TASK_RESUMERS = Symbol.for("atomic-coding-agent/task-resumers@1");
const registry = globalThis as {
	[TASK_RESUMERS]?: { resumers: WeakMap<object, TaskResumer>; boundResumers: Set<TaskResumer> };
};
registry[TASK_RESUMERS] ??= { resumers: new WeakMap(), boundResumers: new Set() };
const { resumers, boundResumers } = registry[TASK_RESUMERS];

/** Registers how the tasks of `owner` (a task supervisor) resume; returns the unregister. */
export function bindTaskResumer(owner: object, resumer: TaskResumer): () => void {
	resumers.set(owner, resumer);
	boundResumers.add(resumer);
	return () => {
		if (resumers.get(owner) === resumer) resumers.delete(owner);
		boundResumers.delete(resumer);
	};
}

/** Whether a bound resumer says the task was stopped and waits for a resume, as a released subagent you quit does. */
export function taskStoppedForResume(taskId: TaskId): boolean {
	for (const resumer of boundResumers) if (resumer.isStopped?.(taskId) === true) return true;
	return false;
}

/** The resumer registered for `owner`, if any. */
export function taskResumer(owner: object): TaskResumer | undefined {
	return resumers.get(owner);
}
