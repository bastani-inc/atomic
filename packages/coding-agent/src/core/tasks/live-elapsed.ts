const seen = new Map<string, { readonly since: number; frozen?: number }>();
const frozenTasks = new Set<string>();
const MAX_FINISHED_TASKS = 2048;

export function isRunningTaskClock(kindOrState: string): boolean {
	return (
		kindOrState === "running" || kindOrState === "cancelling" || kindOrState === "input" || kindOrState === "stopping"
	);
}

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

export function observeTaskClocks(
	tasks: readonly { ref: { taskId: string }; execution: { kind: string }; metrics?: { elapsedMs?: number } }[],
	now = Date.now(),
): void {
	for (const task of tasks)
		liveElapsedMs(task.ref.taskId, task.metrics?.elapsedMs, isRunningTaskClock(task.execution.kind), now);
}
