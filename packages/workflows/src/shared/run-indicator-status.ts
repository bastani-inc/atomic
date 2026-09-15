import { effectiveRunStatus } from "./returned-run-status.js";
import { isTerminalStageStatus } from "./store-internal.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "./store-types.js";
import { reciprocalWorkflowRootRunId } from "./workflow-run-ownership.js";

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
 * Resolve the status represented by the live BACKGROUND widget's indicator.
 *
 * A live run with a pending run/stage prompt is awaiting input. When the
 * caller supplies the complete run collection, pending prompts in hidden
 * nested descendants are attributed only through reciprocal workflow
 * boundaries. Effective terminal and blocked statuses are authoritative,
 * even when a stale prompt marker remains in a snapshot.
 */
export function runIndicatorStatus(run: RunSnapshot, allRuns: readonly RunSnapshot[] = [run]): RunIndicatorStatus {
	const status = effectiveRunStatus(run);
	if (isTerminalOrBlockedRun(run)) return status;
	for (const candidate of visibleRunTreeMembers(run, allRuns)) {
		if (hasPendingInput(candidate, { ignoreTerminalStages: true })) return "awaiting_input";
	}
	return status;
}

/**
 * Preserve status-only attribution for listings, restored status entries and
 * the run picker. Their root/parent links need not establish prompt ownership;
 * only the live widget uses runIndicatorStatus and visibleRunTreeMembers.
 *
 * The status-only traversal is deliberately non-reciprocal: listings, restored
 * `/workflow status` payloads and the picker lack a proven ownership chain, so
 * they accept rootRunId/parentRunId claims. The widget requires reciprocal
 * boundaries and live ancestry, and fails closed on a one-sided claimant.
 * status-indicator-widget-isolation.test.ts pins that difference.
 */
export function statusOnlyRunIndicator(run: RunSnapshot, allRuns: readonly RunSnapshot[] = [run]): RunIndicatorStatus {
	const status = effectiveRunStatus(run);
	if (isTerminalOrBlockedRun(run)) return status;
	if (hasPendingInput(run, { ignoreTerminalStages: false })) return "awaiting_input";

	const runsById = new Map(allRuns.map((candidate) => [candidate.id, candidate]));
	for (const candidate of allRuns) {
		if (candidate.id === run.id || !runBelongsTo(candidate, run, runsById)) continue;
		if (!isTerminalOrBlockedRun(candidate) && hasPendingInput(candidate, { ignoreTerminalStages: false })) {
			return "awaiting_input";
		}
	}
	return status;
}

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
	for (const run of runs) statuses[run.id] = statusOnlyRunIndicator(run, allRuns);
	return statuses;
}

/** Four-way pending-input marker on a stage, independent of terminal status. */
export function stageHasPendingInput(stage: StageSnapshot): boolean {
	return (
		stage.status === "awaiting_input" ||
		stage.awaitingInputSince !== undefined ||
		stage.pendingPrompt !== undefined ||
		stage.inputRequest !== undefined
	);
}

/** Run-level prompt, then stages; optionally ignore residue on terminal stages. */
export function hasPendingInput(
	run: RunSnapshot,
	{ ignoreTerminalStages }: { ignoreTerminalStages: boolean },
): boolean {
	if (run.pendingPrompt !== undefined) return true;
	return run.stages.some(
		(stage) => (!ignoreTerminalStages || !isTerminalStageStatus(stage.status)) && stageHasPendingInput(stage),
	);
}

/**
 * Apply the indicator-specific liveness rule after canonical ownership has
 * already established a complete, acyclic chain to the visible run. Every
 * ownership hop must still cross a running workflow boundary: terminal
 * boundary state and non-running live-child metadata are authoritative over
 * a stale child snapshot.
 */
function hasLiveAncestry(
	candidate: RunSnapshot,
	visibleRun: RunSnapshot,
	runsById: ReadonlyMap<string, RunSnapshot>,
): boolean {
	const visited = new Set<string>();
	let current: RunSnapshot | undefined = candidate;
	while (current.id !== visibleRun.id) {
		if (visited.has(current.id)) return false;
		visited.add(current.id);
		const parentRunId = current.parentRunId;
		const parentStageId = current.parentStageId;
		if (parentRunId === undefined || parentStageId === undefined) return false;
		const parent: RunSnapshot | undefined = runsById.get(parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === parentStageId);
		if (
			parent === undefined ||
			isTerminalOrBlockedRun(parent) ||
			boundary === undefined ||
			boundary.status !== "running"
		) {
			return false;
		}
		current = parent;
	}
	return true;
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

	const runsById = new Map<string, RunSnapshot>();
	const ambiguousRunIds = new Set<string>();
	for (const candidate of allRuns) {
		if (runsById.has(candidate.id)) ambiguousRunIds.add(candidate.id);
		else runsById.set(candidate.id, candidate);
	}
	for (const id of ambiguousRunIds) runsById.delete(id);
	if (ambiguousRunIds.has(visibleRun.id)) return [];

	const members: RunSnapshot[] = [visibleRun];
	for (const candidate of allRuns) {
		if (candidate.id === visibleRun.id || ambiguousRunIds.has(candidate.id) || isTerminalOrBlockedRun(candidate))
			continue;
		if (reciprocalWorkflowRootRunId(runsById, candidate.id) !== visibleRun.id) continue;
		if (hasLiveAncestry(candidate, visibleRun, runsById)) members.push(candidate);
	}
	return members;
}
