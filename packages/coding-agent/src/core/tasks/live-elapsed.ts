/**
 * A task's elapsed time between its own reports, the same in every view (the agent panel, `/tasks`, its chat): one
 * process-wide record of when each running task was first seen, so views that open later agree with earlier ones,
 * and of the time it reached when it stopped running, so a finished row keeps it. The agent panel observes every
 * change of its session's tasks ({@link observeTaskClocks}), so a task's stop is recorded when it happens rather than
 * when a view next looks.
 */

const seen = new Map<string, { readonly since: number; frozen?: number }>();
/** The most tasks remembered; the oldest are forgotten first, and then read their own reported time. */
const MAX_TASKS = 2048;

/**
 * `reportedMs` advanced by the time since the task was first seen running. Once it stops running, the time it reached
 * stays (or `reportedMs`, when the task reports more).
 */
export function liveElapsedMs(
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
): number | undefined {
	let entry = seen.get(taskId);
	if (!running) {
		if (entry === undefined) return reportedMs;
		entry.frozen ??= now - entry.since;
		return Math.max(reportedMs ?? 0, entry.frozen);
	}
	if (entry === undefined || entry.frozen !== undefined) {
		entry = { since: now - (reportedMs ?? 0) };
		seen.delete(taskId);
		seen.set(taskId, entry);
		if (seen.size > MAX_TASKS) seen.delete(seen.keys().next().value as string);
	}
	return Math.max(reportedMs ?? 0, now - entry.since);
}

/** Records the running state of every task in `tasks` now: a task that just stopped keeps the time it reached. */
export function observeTaskClocks(
	tasks: readonly { ref: { taskId: string }; execution: { kind: string }; metrics?: { elapsedMs?: number } }[],
	now = Date.now(),
): void {
	for (const task of tasks)
		liveElapsedMs(task.ref.taskId, task.metrics?.elapsedMs, task.execution.kind === "running", now);
}
