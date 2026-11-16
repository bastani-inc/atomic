/**
 * A running task's elapsed time between its own reports, the same in every view (the agent panel, `/tasks`): one
 * process-wide record of when each running task was first seen, so views that open later agree with earlier ones.
 */

const firstSeen = new Map<string, number>();

/** `reportedMs` advanced by the time since the task was first seen running; a task that stopped running is dropped. */
export function liveElapsedMs(
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
): number | undefined {
	if (!running) {
		firstSeen.delete(taskId);
		return reportedMs;
	}
	let since = firstSeen.get(taskId);
	if (since === undefined) {
		since = now - (reportedMs ?? 0);
		firstSeen.set(taskId, since);
	}
	return Math.max(reportedMs ?? 0, now - since);
}
