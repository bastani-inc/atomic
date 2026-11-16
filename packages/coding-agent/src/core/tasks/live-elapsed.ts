const seen = new Map<string, { readonly since: number; frozen?: number }>();
const frozenTasks = new Set<string>();
const MAX_FINISHED_TASKS = 2048;

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
		entry.frozen = Math.max(reportedMs ?? 0, entry.frozen ?? now - entry.since);
		frozenTasks.add(taskId);
		if (frozenTasks.size > MAX_FINISHED_TASKS) {
			const oldest = frozenTasks.values().next().value;
			if (oldest !== undefined) {
				frozenTasks.delete(oldest);
				seen.delete(oldest);
			}
		}
		return entry.frozen;
	}
	if (entry === undefined || entry.frozen !== undefined) {
		entry = { since: now - Math.max(reportedMs ?? 0, entry?.frozen ?? 0) };
		frozenTasks.delete(taskId);
		seen.set(taskId, entry);
	}
	return Math.max(reportedMs ?? 0, now - entry.since);
}

/** Records the running state of every task in `tasks` now: a task that just stopped keeps the time it reached. */
export function observeTaskClocks(
	tasks: readonly { ref: { taskId: string }; execution: { kind: string }; metrics?: { elapsedMs?: number } }[],
	now = Date.now(),
): void {
	for (const task of tasks)
		liveElapsedMs(
			task.ref.taskId,
			task.metrics?.elapsedMs,
			task.execution.kind === "running" || task.execution.kind === "cancelling",
			now,
		);
}
