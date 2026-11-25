import type { CancelCause, OwnerCloseCause, TaskResult } from "./contracts.js";

export type CancelledTaskResult = Extract<TaskResult, { kind: "cancelled" }>;

const CANCEL_CAUSE_TEXT: Record<CancelCause, string> = {
	user: "stop requested",
	"owner-close": "task owner closed",
	"execution-timeout": "timed out",
	"output-limit": "output limit reached",
	"parent-handoff": "handed off",
	// A shell cannot resume: a pause stops it, and the resumed work redoes the step.
	pause: "stopped by a pause",
	quit: "quit · paused · awaiting resume",
	shutdown: "Atomic shut down",
};

const OWNER_CLOSE_TEXT: Record<OwnerCloseCause | "stage-close", string> = {
	"session-close": "session closed",
	// Older stored task results used this close reason.
	"stage-close": "session closed",
	"app-shutdown": "Atomic shut down",
};

/** A timeout in milliseconds as whole or fractional seconds: `300 seconds`, `1 second`. */
export function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * Why a cancelled task stopped, in plain words. It names the close of the task's owner that ended it and the length
 * of the execution timeout that stopped it when the result records them (#4639): `session closed`,
 * `timed out after 300 seconds`.
 */
export function cancelReasonText(result: CancelledTaskResult): string {
	if (result.cause === "owner-close" && result.ownerClose !== undefined) return OWNER_CLOSE_TEXT[result.ownerClose];
	if (result.cause === "execution-timeout" && result.executionTimeoutMs !== undefined)
		return `timed out after ${formatTimeoutSeconds(result.executionTimeoutMs)}`;
	return CANCEL_CAUSE_TEXT[result.cause];
}
