import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

/** The run a `pauseTurn` ended has settled and waits for its next message. */
export function settleTurnPause(session: AgentSession): void {
	session._turnPause?.resolve();
}

/**
 * The user's next message reached a session paused by `pauseTurn`: release its hold once the paused run has settled,
 * so that message starts the next turn and what was held follows it. Undefined when no such pause holds the queue.
 */
export function releaseTurnPause(session: AgentSession): Promise<void> | undefined {
	if (session._turnPauseRelease !== undefined) return session._turnPauseRelease;
	const pause = session._turnPause;
	if (pause === undefined) return undefined;
	const release = session.resumeQueuedMessages().then(
		() => {},
		() => {},
	);
	const tracked = release.finally(() => {
		if (session._turnPauseRelease === tracked) session._turnPauseRelease = undefined;
		if (session._turnPause === pause) session._turnPause = undefined;
	});
	session._turnPauseRelease = tracked;
	return tracked;
}
