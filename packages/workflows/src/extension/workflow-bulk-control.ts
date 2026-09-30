import type { WorkflowControlFailedRun } from "./workflow-control-failure.js";

export type BulkRunResult =
	| { readonly ok: true; readonly runId: string; readonly message?: string }
	| { readonly ok: false; readonly runId: string; readonly reason: string; readonly message?: string };

type BulkFailure = Extract<BulkRunResult, { readonly ok: false }>;

function isAlreadyPaused(result: BulkRunResult): boolean {
	return !result.ok && result.reason === "already_paused";
}

function leavesRunActive(result: BulkRunResult): result is BulkFailure {
	return !result.ok && result.reason !== "already_paused" && result.reason !== "already_ended";
}

export function bulkFailedRuns(results: readonly BulkRunResult[]): WorkflowControlFailedRun[] {
	return results.filter(leavesRunActive).map((result) => ({
		runId: result.runId,
		reason: result.reason,
		...(result.message === undefined ? {} : { message: result.message }),
	}));
}

export function bulkAlreadyPausedCount(results: readonly BulkRunResult[]): number {
	return results.filter(isAlreadyPaused).length;
}

export function bulkUnstoppedStatus(
	results: readonly BulkRunResult[],
): { status: "partial" } | { status: "noop"; code: "control_failed" } {
	return results.some((result) => result.ok) ? { status: "partial" } : { status: "noop", code: "control_failed" };
}

export function bulkFailureMessage<T extends BulkRunResult>(
	verb: "Paused" | "Quit",
	action: "pause" | "quit",
	results: readonly T[],
	describeSuccess: (result: Extract<T, { readonly ok: true }>) => string,
): string {
	const successes = results.filter((result) => result.ok).length;
	const failures = results.filter(leavesRunActive).length;
	const outcomes = results
		.map((result) =>
			result.ok
				? describeSuccess(result as Extract<T, { readonly ok: true }>)
				: `${result.runId}: ${result.reason}${result.message === undefined ? "" : ` (${result.message})`}`,
		)
		.join(", ");
	return `${successes > 0 ? `${verb} ${successes} run(s); ` : ""}failed to ${action} ${failures} run(s); outcomes: ${outcomes}.`;
}
