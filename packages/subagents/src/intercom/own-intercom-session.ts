import type { SessionManager } from "@bastani/atomic";
import { readPreviousIntercomId } from "../runs/foreground/subagent-child-session.js";
import type { SubagentState } from "../shared/types.js";

/** Intercom's notice, on a session's own event bus, that its client registered under `sessionId`. */
export const INTERCOM_CONNECTED_EVENT = "intercom:connected";

/**
 * The Intercom id this session registered under: what its own client reported last, or what its Intercom
 * extension recorded in its entries. Undefined until it has connected once.
 */
export function ownIntercomSessionId(
	state: Pick<SubagentState, "ownIntercomSession">,
	sessionManager: Pick<SessionManager, "getSessionId" | "getEntries">,
): string | undefined {
	const sessionId = sessionManager.getSessionId();
	if (state.ownIntercomSession?.sessionId === sessionId) return state.ownIntercomSession.intercomSessionId;
	try {
		return readPreviousIntercomId(sessionManager);
	} catch {
		return undefined;
	}
}

/** Remember the Intercom id this session's own client registered under, for the children it launches. */
export function trackOwnIntercomSession(
	events: { on(channel: string, handler: (payload: unknown) => void): () => void },
	state: Pick<SubagentState, "ownIntercomSession" | "currentSessionId">,
): () => void {
	return events.on(INTERCOM_CONNECTED_EVENT, (payload) => {
		const intercomSessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
		if (typeof intercomSessionId !== "string" || !intercomSessionId || !state.currentSessionId) return;
		state.ownIntercomSession = { sessionId: state.currentSessionId, intercomSessionId };
	});
}
