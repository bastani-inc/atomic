import { effectiveRunStatus } from "./returned-run-status.js";
import type { RunSnapshot, RunStatus } from "./store-types.js";

export type RunIndicatorStatus = RunStatus | "awaiting_input";

/** True while a live run or one of its stages is waiting for human input. */
export function runAwaitsInput(run: RunSnapshot): boolean {
	return (
		run.endedAt === undefined &&
		(run.pendingPrompt !== undefined || run.stages.some((stage) => stage.status === "awaiting_input"))
	);
}

/**
 * True when a visible root run, or one of its hidden nested workflow runs,
 * awaits human input. Nested snapshots point at their ultimate root through
 * `rootRunId`.
 */
export function subtreeAwaitsInput(root: RunSnapshot, allRuns: readonly RunSnapshot[]): boolean {
	if (runAwaitsInput(root)) return true;
	return allRuns.some((run) => run.rootRunId === root.id && runAwaitsInput(run));
}

/** A paused run explicitly stopped with `/workflow quit`, not an ordinary pause. */
export function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

/**
 * Resolve the status used by run-level indicators.
 *
 * Awaiting input replaces only live running/paused indicators. Quit keeps its
 * existing paused treatment, and every other effective status—including
 * terminal and blocked states—wins over stale prompt metadata.
 */
export function runIndicatorStatus(run: RunSnapshot, allRuns: readonly RunSnapshot[]): RunIndicatorStatus {
	if (isQuitRun(run)) return effectiveRunStatus(run);
	const status = effectiveRunStatus(run);
	if (status !== "running" && status !== "paused") return status;
	return subtreeAwaitsInput(run, allRuns) ? "awaiting_input" : status;
}
