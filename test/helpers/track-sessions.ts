import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { CollectionCount } from "./collect-garbage.js";

type Dispose = typeof AgentSession.prototype.dispose;
type Open = typeof SessionManager.open;
type Create = typeof SessionManager.create;

export function trackLastEntry(tracked: CollectionCount, manager: SessionManager): void {
	const entry = manager.getEntries().at(-1);
	if (entry !== undefined) tracked.track(entry);
}

export function trackSessions(tracked: CollectionCount): () => void {
	const dispose: Dispose = AgentSession.prototype.dispose;
	const open: Open = SessionManager.open;
	const create: Create = SessionManager.create;
	AgentSession.prototype.dispose = function trackedDispose(this: AgentSession) {
		tracked.track(this);
		trackLastEntry(tracked, this.sessionManager);
		return dispose.call(this);
	};
	SessionManager.open = async function trackedOpen(...args: Parameters<Open>) {
		const manager = await open.apply(SessionManager, args);
		tracked.track(manager);
		return manager;
	} as Open;
	SessionManager.create = async function trackedCreate(...args: Parameters<Create>) {
		const manager = await (create as (...rest: Parameters<Create>) => Promise<SessionManager>).apply(
			SessionManager,
			args,
		);
		tracked.track(manager);
		return manager;
	} as Create;
	return () => {
		AgentSession.prototype.dispose = dispose;
		SessionManager.open = open;
		SessionManager.create = create;
	};
}
