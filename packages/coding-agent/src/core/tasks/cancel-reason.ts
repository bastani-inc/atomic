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

const OWNER_CLOSE_TEXT: Record<OwnerCloseCause, string> = {
	"session-close": "session closed",
	"stage-close": "workflow stage closed",
	"app-shutdown": "Atomic shut down",
};

/** A timeout in milliseconds as whole or fractional seconds: `300 seconds`, `1 second`. */
export function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * Why a cancelled task stopped, in plain words. It names the close of the task's owner that ended it and the length
 * of the execution timeout that stopped it when the result records them (#4639): `workflow stage closed`,
 * `timed out after 300 seconds`.
 */
export function cancelReasonText(result: CancelledTaskResult): string {
	if (result.cause === "owner-close" && result.ownerClose !== undefined) return OWNER_CLOSE_TEXT[result.ownerClose];
	if (result.cause === "execution-timeout" && result.executionTimeoutMs !== undefined)
		return `timed out after ${formatTimeoutSeconds(result.executionTimeoutMs)}`;
	return CANCEL_CAUSE_TEXT[result.cause];
}

/** The longest execution timeout a shell command may ask for, in seconds. */
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

/**
 * What to do about an execution timeout that is too short, for the text that names it (#4639). Advice to ask for a
 * larger timeout stops at the longest one, where the only way on is to split the run.
 */
export function longerRunAdvice(timeoutMs: number | undefined, action: "launch" | "rerun"): string {
	if (timeoutMs !== undefined && timeoutMs >= MAX_COMMAND_TIMEOUT_SECONDS * 1000)
		return `${MAX_COMMAND_TIMEOUT_SECONDS} seconds is the longest timeout; split a longer run into shorter commands.`;
	return action === "launch"
		? `launch it with a larger timeout (up to ${MAX_COMMAND_TIMEOUT_SECONDS} seconds) for a longer run.`
		: "run it again with a larger timeout.";
}
