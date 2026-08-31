import { effectiveRunStatus } from "./returned-run-status.js";
import type { RunSnapshot, RunStatus } from "./store-types.js";

/** The status represented by a run's primary indicator. */
export type RunIndicatorStatus = RunStatus | "awaiting_input";

const TERMINAL_OR_BLOCKED = new Set<RunStatus>(["completed", "failed", "killed", "cancelled", "skipped", "blocked"]);

/**
 * Whether a run status is authoritative over any stale awaiting-input fields.
 * A terminal or blocked run never contributes human-input state to a visible
 * ancestor.
 */
function isTerminalOrBlockedRun(run: RunSnapshot): boolean {
	return TERMINAL_OR_BLOCKED.has(effectiveRunStatus(run));
}

/**
 * Resolve the status represented by a run's primary indicator.
 *
 * A live run with a pending run/stage prompt is awaiting input. When the
 * caller supplies the complete run collection, pending prompts in hidden
 * nested descendants are attributed to the visible ancestor by following
 * `rootRunId` and `parentRunId`. Effective terminal and blocked statuses are
 * authoritative, even when a stale prompt marker remains in a snapshot.
 */
export function runIndicatorStatus(run: RunSnapshot, allRuns: readonly RunSnapshot[] = [run]): RunIndicatorStatus {
	const status = effectiveRunStatus(run);
	if (isTerminalOrBlockedRun(run)) return status;
	if (runHasPendingInput(run)) return "awaiting_input";

	for (const candidate of visibleRunTreeMembers(run, allRuns)) {
		if (candidate.id !== run.id && runHasPendingInput(candidate)) return "awaiting_input";
	}
	return status;
}

/**
 * Precompute the indicator status of each listed run against the complete
 * run collection. The result is plain serializable data, so a surface whose
 * payload is persisted and re-rendered after a session restore (e.g. the
 * `/workflow status` chat entry) keeps hidden-descendant prompt attribution
 * without serializing the hidden run snapshots themselves.
 */
export function resolveRunIndicatorStatuses(
	runs: readonly RunSnapshot[],
	allRuns: readonly RunSnapshot[],
): Readonly<Record<string, RunIndicatorStatus>> {
	const statuses: Record<string, RunIndicatorStatus> = {};
	for (const run of runs) statuses[run.id] = runIndicatorStatus(run, allRuns);
	return statuses;
}

function runHasPendingInput(run: RunSnapshot): boolean {
	if (run.pendingPrompt !== undefined) return true;
	return run.stages.some(
		(stage) =>
			stage.status === "awaiting_input" ||
			stage.awaitingInputSince !== undefined ||
			stage.pendingPrompt !== undefined ||
			stage.inputRequest !== undefined,
	);
}

/**
 * Check whether a candidate is in an ancestor's explicit or inferred run
 * tree. Parent traversal is cycle-safe because restored snapshots can contain
 * incomplete or malformed ancestry.
 */
function runBelongsTo(
	candidate: RunSnapshot,
	ancestor: RunSnapshot,
	runsById: ReadonlyMap<string, RunSnapshot>,
): boolean {
	if (candidate.rootRunId === ancestor.id) return true;

	const visited = new Set<string>();
	let current: RunSnapshot | undefined = candidate;
	while (current !== undefined && current.parentRunId !== undefined) {
		if (current.parentRunId === ancestor.id) return true;
		if (visited.has(current.id)) return false;
		visited.add(current.id);
		current = runsById.get(current.parentRunId);
	}
	return false;
}

/**
 * Return the live, non-terminal members attributed to a visible run.
 *
 * This is the shared ancestry boundary for run indicators and widget-local
 * projections. A terminal or blocked visible root is authoritative, so its
 * descendants cannot manufacture a stale awaiting-input state.
 */
export function visibleRunTreeMembers(
	visibleRun: RunSnapshot,
	allRuns: readonly RunSnapshot[] = [visibleRun],
): RunSnapshot[] {
	if (isTerminalOrBlockedRun(visibleRun)) return [];

	const runsById = new Map(allRuns.map((candidate) => [candidate.id, candidate]));
	const members: RunSnapshot[] = [visibleRun];
	for (const candidate of allRuns) {
		if (candidate.id === visibleRun.id || isTerminalOrBlockedRun(candidate)) continue;
		if (runBelongsTo(candidate, visibleRun, runsById)) members.push(candidate);
	}
	return members;
}
