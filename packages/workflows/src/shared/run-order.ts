import type { RunIndicatorStatus } from "./run-indicator-status.js";
import type { RunSnapshot } from "./store-types.js";

const ACTIVE_RANK: Partial<Record<RunIndicatorStatus, number>> = {
	awaiting_input: 0,
	blocked: 0,
	running: 1,
	paused: 2,
};
const OTHER_ACTIVE_RANK = 3;

const TERMINAL_RANK: Partial<Record<RunIndicatorStatus, number>> = {
	blocked: 0,
	failed: 1,
	killed: 1,
	cancelled: 2,
	skipped: 3,
	completed: 4,
};
const OTHER_TERMINAL_RANK = 5;

function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

function statusRank(run: RunSnapshot, statusOf: (run: RunSnapshot) => RunIndicatorStatus): number {
	if (run.endedAt !== undefined) return TERMINAL_RANK[statusOf(run)] ?? OTHER_TERMINAL_RANK;
	if (isQuitRun(run)) return ACTIVE_RANK.paused ?? OTHER_ACTIVE_RANK;
	return ACTIVE_RANK[statusOf(run)] ?? OTHER_ACTIVE_RANK;
}

/**
 * Order shared by the workflow run lists: active runs before ended runs, then
 * status rank (runs that need the user first), then newest first. Each run's
 * status is resolved once, not once per comparison.
 */
export function sortRunsByStatus<T>(
	items: readonly T[],
	runOf: (item: T) => RunSnapshot,
	statusOf: (run: RunSnapshot) => RunIndicatorStatus,
): T[] {
	return items
		.map((item) => {
			const run = runOf(item);
			return { item, run, rank: statusRank(run, statusOf) };
		})
		.sort((a, b) => {
			const aEnded = a.run.endedAt !== undefined;
			if (aEnded !== (b.run.endedAt !== undefined)) return aEnded ? 1 : -1;
			const rankDelta = a.rank - b.rank;
			if (rankDelta !== 0) return rankDelta;
			return aEnded ? (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0) : b.run.startedAt - a.run.startedAt;
		})
		.map((entry) => entry.item);
}
