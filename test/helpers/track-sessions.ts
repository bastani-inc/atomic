import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { CollectionCount } from "./collect-garbage.js";

type Dispose = typeof AgentSession.prototype.dispose;
type Open = typeof SessionManager.open;

export function trackSessions(tracked: CollectionCount): () => void {
	const dispose: Dispose = AgentSession.prototype.dispose;
	const open: Open = SessionManager.open;
	AgentSession.prototype.dispose = function trackedDispose(this: AgentSession) {
		tracked.track(this);
		return dispose.call(this);
	};
	SessionManager.open = async function trackedOpen(...args: Parameters<Open>) {
		const manager = await open.apply(SessionManager, args);
		tracked.track(manager);
		return manager;
	} as Open;
	return () => {
		AgentSession.prototype.dispose = dispose;
		SessionManager.open = open;
	};
}
