import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";
import { bindChatReceipt } from "./chat-receipts.js";
import { physicalForkHeader, type SessionManager } from "./session-manager-core.ts";
import { saveChatRecord } from "./storage/session/chat-records.js";

type Pending = NonNullable<AgentSessionInternalSurface["_transcriptAppend"]>;
type Scope = NonNullable<ReturnType<SessionManager["chatRecordScope"]>>;
const overtakings = new WeakMap<Pending, { scope: Scope; firstNotice: string; lastNotice: string }>();

/** A notice can be displayed while the prompt that was shown before it is still waiting for its own write. */
export function noticeOvertookPrompt(session: AgentSessionInternalSurface, id: string): void {
	const pending = session._transcriptAppend;
	if (pending?.message.role !== "user" || !session._messagesAwaitingPersistence.has(pending.message)) return;
	const manager = session.sessionManager;
	if (!pending.owner || pending.owner !== physicalForkHeader(manager)) return;
	const previous = overtakings.get(pending);
	const entry = manager.getEntry(id);
	if (entry?.parentId !== (previous?.lastNotice ?? pending.previousLeaf)) return;
	if (previous) {
		previous.lastNotice = id;
		return;
	}
	const scope = manager.chatRecordScope();
	if (scope) overtakings.set(pending, { scope, firstNotice: id, lastNotice: id });
}

/** Publish only an uninterrupted chain of overtaking notices on this incarnation of this branch. */
export function recordPromptOrder(session: AgentSessionInternalSurface, promptId: string, event: object): void {
	const pending = session._transcriptAppend;
	if (!pending) return;
	const moved = overtakings.get(pending);
	if (!moved) return;
	overtakings.delete(pending);
	const manager = session.sessionManager;
	const scope = manager.chatRecordScope();
	if (
		!scope ||
		scope.store !== moved.scope.store ||
		scope.owner.id !== moved.scope.owner.id ||
		scope.owner.epoch !== moved.scope.owner.epoch ||
		manager.getEntry(promptId)?.parentId !== moved.lastNotice
	)
		return;
	bindChatReceipt(event, { id: promptId, anchor: moved.firstNotice });
	saveChatRecord(scope, moved.firstNotice, { kind: "promptBefore", promptId });
}
