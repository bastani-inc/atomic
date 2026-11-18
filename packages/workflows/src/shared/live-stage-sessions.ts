import type { SessionManager } from "@bastani/atomic";

/**
 * The stage sessions open in this process, by session id, held weakly: a stage launched with `context: "fork"` from
 * one of them reads the entry it forks at synchronously at launch, before any later turn of the source can land.
 */
const liveSessions = new Map<string, WeakRef<Pick<SessionManager, "getLeafId">>>();
const released = new FinalizationRegistry<string>((sessionId) => {
	if (liveSessions.get(sessionId)?.deref() === undefined) liveSessions.delete(sessionId);
});

/** Record a stage's session manager as the live holder of its session. */
export function registerLiveStageSession(manager: Pick<SessionManager, "getSessionId" | "getLeafId">): void {
	const sessionId = manager.getSessionId();
	liveSessions.set(sessionId, new WeakRef(manager));
	released.register(manager, sessionId);
}

/** The entry a live stage session continues from, or undefined when no session with that id is open here. */
export function liveStageSessionLeaf(sessionId: string): string | undefined {
	return liveSessions.get(sessionId)?.deref()?.getLeafId() ?? undefined;
}
