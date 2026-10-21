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
 * Comparator shared by the workflow run lists: active runs before ended runs,
 * then status rank (runs that need the user first), then newest first.
 */
export function compareRunsByStatus(
	statusOf: (run: RunSnapshot) => RunIndicatorStatus,
): (a: RunSnapshot, b: RunSnapshot) => number {
	return (a, b) => {
		const aEnded = a.endedAt !== undefined;
		if (aEnded !== (b.endedAt !== undefined)) return aEnded ? 1 : -1;
		const rankDelta = statusRank(a, statusOf) - statusRank(b, statusOf);
		if (rankDelta !== 0) return rankDelta;
		return aEnded ? (b.endedAt ?? 0) - (a.endedAt ?? 0) : b.startedAt - a.startedAt;
	};
}
