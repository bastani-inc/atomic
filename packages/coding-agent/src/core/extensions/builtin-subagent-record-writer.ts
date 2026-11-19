import { appendOwnedSubagentChildRecord, type SessionManager } from "../session-manager-core.ts";
import { extensionWorkOpen } from "./extension-work.ts";
import type { ExtensionAPI, ExtensionRuntime } from "./types.ts";

type Session = { readonly sessionManager: SessionManager; readonly _disposed: boolean };
const sessions = new WeakMap<ExtensionRuntime, WeakRef<Session>>();
const ownerScopes = new WeakMap<SessionManager, object>();
const acquireWriter = Symbol.for("atomic.subagents/acquire-child-record-writer@1");

export function bindBuiltinChildRecordSession(runtime: ExtensionRuntime, session: Session): void {
	sessions.set(runtime, new WeakRef(session));
}

function ownerWriter(session: Session, ownerId: string) {
	const owner = new WeakRef(session);
	const manager = session.sessionManager;
	return (data: { readonly childId?: string; readonly owner?: { readonly sessionId?: string } }) => {
		return appendOwnedSubagentChildRecord(manager, ownerId, data, () => {
			const live = owner.deref();
			return live !== undefined && !live._disposed && live.sessionManager === manager;
		});
	};
}

/** Only the verified shipped extension receives this symbol. A reload can seal its ordinary API after admission. */
export function installBuiltinChildRecordWriter(api: ExtensionAPI, resolve: () => ExtensionRuntime): void {
	Object.defineProperty(api, acquireWriter, {
		value: (ownerId: string) => {
			const runtime = resolve();
			const session = sessions.get(runtime)?.deref();
			if (!session || session._disposed || session.sessionManager.getSessionId() !== ownerId)
				throw new Error("No live session owns this subagent-child record writer.");
			const scope = ownerScopes.get(session.sessionManager) ?? {};
			ownerScopes.set(session.sessionManager, scope);
			return { scope, writable: () => extensionWorkOpen(runtime), save: ownerWriter(session, ownerId) };
		},
	});
}
