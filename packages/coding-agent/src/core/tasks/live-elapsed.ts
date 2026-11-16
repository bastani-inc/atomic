/**
 * A running task's elapsed time between its progress reports.
 *
 * A task reports its elapsed time only with progress, so a view keeps the clock running between reports from the
 * moment the task was first seen running. Every view in the process reads the same moment, so the agent panel and
 * /tasks show the same time for the same task whenever either first saw it.
 */
const firstSeen = new Map<string, number>();

/**
 * The elapsed time to show for a task: its reported time, or longer while it runs. `running: false` forgets it, so a
 * resumed task starts its clock again from its next report.
 */
export function liveElapsedMs(
	id: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
): number | undefined {
	if (!running) {
		firstSeen.delete(id);
		return reportedMs;
	}
	const since = firstSeen.get(id) ?? now - (reportedMs ?? 0);
	if (!firstSeen.has(id)) firstSeen.set(id, since);
	return Math.max(reportedMs ?? 0, now - since);
}
