import type { TaskRecord } from "./contracts.js";

/**
 * Which session a task belongs to, within the task owner that runs it. An in-process subagent runs its shells in the
 * owner of the session that launched it, so one owner holds the tasks of several sessions: the owner's own session's
 * (its shells, and the subagents it launched) and each subagent's shells. A task names the subagent session that
 * launched it in `launchedBy`; the owner's own tasks name none.
 *
 * A task's completion notice goes to its session only, and a session lists only its own tasks: the owner's chat
 * never sees a subagent's shells, and a subagent never sees the owner's.
 */

type TaskListOwner = { readonly backgroundTasks: readonly TaskRecord[] };
const listOwners = new WeakMap<readonly TaskRecord[], WeakRef<TaskListOwner>>();

/** Keep a projected list attributable to its chat without keeping the chat alive. */
export function scopedBackgroundTasks(owner: TaskListOwner, tasks: TaskRecord[]): TaskRecord[] {
	listOwners.set(tasks, new WeakRef(owner));
	return tasks;
}

export function backgroundTaskOwner(tasks: readonly TaskRecord[]): TaskListOwner | undefined {
	return listOwners.get(tasks)?.deref();
}

/** The session key of a task: the subagent session that launched it, or `undefined` for the owner's own session. */
export function taskSessionKey(task: Pick<TaskRecord, "launchedBy">): string | undefined {
	return task.launchedBy;
}

/** Whether `task` belongs to `session`: a subagent session's id, or `undefined` for the owner's own session. */
export function belongsToSession(task: Pick<TaskRecord, "launchedBy">, session: string | undefined): boolean {
	return taskSessionKey(task) === session;
}

/** The tasks of `session` among an owner's tasks, in their order: what that session's `/tasks` lists. */
export function sessionTasks<T extends Pick<TaskRecord, "launchedBy">>(
	tasks: readonly T[],
	session: string | undefined,
): T[] {
	return tasks.filter((task) => belongsToSession(task, session));
}
