import { isGitUnavailableError, isWorkspaceError } from "../worktree-snapshot/errors.ts";
import { isResumeError } from "./errors.ts";

/** Whether `error` is a resume failure the user can act on: a typed resume, workspace or Git-availability error. */
export function isResumeFailure(error: unknown): error is Error {
	return isResumeError(error) || isWorkspaceError(error) || isGitUnavailableError(error);
}

/**
 * The message to print for `error` when a resume stops on a failure the user can act on, else undefined. A drift error
 * whose automatic restore failed already names that failure and its fix.
 */
export function resumeFailureMessage(error: unknown): string | undefined {
	return isResumeFailure(error) ? error.message : undefined;
}
