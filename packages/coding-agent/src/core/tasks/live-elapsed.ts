/**
 * A task's elapsed time between its own reports, the same in every view (the agent panel, `/tasks`, its chat): one
 * process-wide record of when each running task was first seen, so views that open later agree with earlier ones,
 * and of the time it showed when it stopped running, so a finished row keeps it.
 */

const seen = new Map<string, { readonly since: number; frozen?: number }>();

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
		seen.set(taskId, entry);
	}
	return Math.max(reportedMs ?? 0, now - entry.since);
}
