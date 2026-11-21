import type { SessionStore } from "@bastani/atomic";

/**
 * The store a fresh child's own session is created in: the store its parent's session is in, the one Atomic was
 * configured with (SQLite by default, a database adapter, or memory), so a child is kept, resumed and woken wherever
 * its parent is. A parent kept in JSONL files has none: its children keep their own session files beside the parent's,
 * as a JSONL store keeps one file per session.
 */
export function childSessionStore(parent: {
	readonly getSessionStore?: () => SessionStore | undefined;
}): SessionStore | undefined {
	// A session manager that names no store of its own (an older or partial one) keeps its children in files, as before.
	const store = typeof parent.getSessionStore === "function" ? parent.getSessionStore() : undefined;
	return store === undefined || store.descriptor.adapter === "jsonl" ? undefined : store;
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
