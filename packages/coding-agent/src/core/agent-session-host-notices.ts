import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { AgentSessionEvent } from "./agent-session-types.js";
import {
	boundHostNoticeText,
	HOST_NOTICE_TYPE,
	type HostNotice,
	hostNoticeForEvent,
	hostNoticeMessage,
} from "./host-notices.ts";
import type { CustomMessage } from "./messages.ts";
import { sessionGenerationClosing } from "./session-lifecycle-work.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/**
 * Saves the line `event` puts in the session's chat, if any, and returns the message that shows it (#5649). The entry
 * is queued before the event's listeners run, so anything they append comes after it, as it does on screen.
 */
export function recordHostNotice(
	session: AgentSession,
	event: AgentSessionEvent,
): CustomMessage<HostNotice> | undefined {
	// A closing session admits nothing more, and nothing follows it to show the line (#5649).
	if (session._disposed || sessionGenerationClosing.has(session)) return undefined;
	const found = hostNoticeForEvent(event, session._compactionReason);
	if (found === undefined) return undefined;
	const notice: HostNotice = { level: found.level, text: boundHostNoticeText(found.text) };
	const message = hostNoticeMessage(notice, Date.now());
	const manager = session.sessionManager;
	let saved: Promise<string> | undefined;
	try {
		saved = manager.appendCustomEntry(HOST_NOTICE_TYPE, notice);
	} catch {
		// A session that can no longer be written still shows the line; it is lost with the session's other unsaved work.
	}
	if (saved !== undefined) {
		const pending = unsaved.get(session) ?? new Map<HostNotice, CustomMessage<HostNotice>>();
		unsaved.set(session, pending);
		pending.set(notice, message);
		const announced = saved.then(
			(id) => {
				pending.delete(notice);
				const entry = manager.getEntry(id);
				// A host that reads the session from its store learns the entry exists.
				if (entry !== undefined && session.sessionManager === manager)
					session._emit({ type: "entry_appended", entry });
			},
			() => {
				pending.delete(notice);
			},
		);
		// Whatever waits for the session's events to settle, such as the prompt that ended this way or the next model
		// request, also waits for the line to be saved. A failure already in the queue stays there for them to see.
		const queue = session._agentEventQueue;
		const settled = queue.then(
			() => announced,
			(error: unknown) => announced.then(() => Promise.reject(error)),
		);
		settled.catch(() => {});
		session._agentEventQueue = settled;
	}
	return message;
}

/** Lines a session has shown and is still saving, keyed by the data of the entry that saves each. */
const unsaved = new WeakMap<object, Map<HostNotice, CustomMessage<HostNotice>>>();

/**
 * The lines `session` has shown but not yet saved, other than any among `entries`: a chat opened in that moment reads
 * them with the saved transcript, since the event that showed them has passed.
 */
export function unsavedHostNotices(session: object, entries: readonly SessionEntry[]): CustomMessage<HostNotice>[] {
	const pending = unsaved.get(session);
	if (pending === undefined || pending.size === 0) return [];
	const saved = new Set(entries.flatMap((entry) => (entry.type === "custom" ? [entry.data] : [])));
	return [...pending].flatMap(([notice, message]) => (saved.has(notice) ? [] : [message]));
}

/** Shows a saved notice in the chats that follow the session, as a display-only message. */
export function showHostNotice(session: AgentSession, message: CustomMessage<HostNotice>): void {
	session._emit({ type: "message_start", message });
	session._emit({ type: "message_end", message });
}
