import type { SessionStore } from "@bastani/atomic";
import { warnDeprecationOnce } from "./removed-routing-warning.js";

/**
 * The store a child's own session is created in: always the store its parent's session is in, whatever it is (SQLite
 * by default, a database adapter, memory, or a JSONL directory), so a child is kept, resumed and woken wherever its
 * parent is. The child's working directory, worktree or launch options never choose another store.
 */
export function childSessionStore(parent: {
	readonly getSessionStore?: () => SessionStore | undefined;
}): SessionStore | undefined {
	// Only a session manager that names no store of its own (an older or partial one) has none to share.
	return typeof parent.getSessionStore === "function" ? parent.getSessionStore() : undefined;
}

/** Warn once that a session directory for subagents, the launch's `sessionDir` or config's `defaultSessionDir`, is ignored. */
export function warnIgnoredSessionDir(option: "sessionDir" | "defaultSessionDir"): void {
	warnDeprecationOnce(
		`"${option}" is ignored: a subagent's session is always kept in the session store of the session that launched it.`,
	);
}

/**
 * How to find a child's session to read it: its session file when it has one, otherwise its `history://` URL, scoped
 * to the child's project when the child ran in another directory than its parent (a named worktree), since a history
 * URL reads only the current project's sessions by default.
 */
export function childSessionLocator(child: {
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly cwd?: string;
	readonly parentCwd?: string;
}): string | undefined {
	if (child.sessionFile) return child.sessionFile;
	if (!child.sessionId) return undefined;
	const url = `history://sessions/${child.sessionId}`;
	return child.cwd !== undefined && child.parentCwd !== undefined && child.cwd !== child.parentCwd
		? `${url}?project=${encodeURIComponent(child.cwd)}`
		: url;
}
