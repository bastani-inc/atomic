import { resolveParentSessionPaths } from "./session-manager-list.ts";
import type { SessionInfo, SessionListProgress } from "./session-manager-types.ts";
import type { SessionListQuery, SessionStore } from "./storage/session/types.js";

export async function listSessionStore(
	store: SessionStore,
	query: SessionListQuery,
	onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	for await (const summary of store.list(query)) {
		sessions.push({
			path: summary.location ?? summary.id,
			id: summary.id,
			cwd: summary.cwd,
			created: new Date(summary.createdAt),
			modified: new Date(summary.modifiedAt),
			messageCount: summary.messageCount,
			firstMessage: summary.firstMessage || "(no messages)",
			allMessagesText: summary.searchText,
			...(summary.name === undefined ? {} : { name: summary.name }),
			...(summary.hasName ? { hasName: true } : {}),
			...(summary.internal ? { internal: true } : {}),
			...(summary.workflow === undefined ? {} : { workflow: summary.workflow }),
			...(summary.summary === undefined ? {} : { summary: summary.summary }),
			...(summary.summarizedThroughId === undefined ? {} : { summarizedThroughId: summary.summarizedThroughId }),
			...(summary.parentSessionId === undefined ? {} : { parentSessionPath: summary.parentSessionId }),
		});
	}
	const resolved = resolveParentSessionPaths(sessions);
	resolved.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	onProgress?.(resolved.length, resolved.length, resolved);
	return resolved;
}
