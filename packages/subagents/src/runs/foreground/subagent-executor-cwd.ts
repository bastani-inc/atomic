import * as path from "node:path";

/** Resolve a caller-provided cwd against the current session cwd. */
export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

/** Why a launch's cwd is missing, when a tool call of the same turn may still be creating it (#5202). */
export function missingCwdMessage(cwd: string): string {
	return `cwd does not exist: ${cwd}. It may still be being created by a parallel tool call in this same turn (tool calls in one message run at the same time, so a \`git worktree add\` beside this launch may not have finished). Launch after that call returns, or pass \`worktree: { branch, base?, path? }\` to have the subagent tool create the worktree before the child starts.`;
}
