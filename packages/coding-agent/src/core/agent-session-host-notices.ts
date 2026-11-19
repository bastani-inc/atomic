import { randomUUID } from "node:crypto";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { AgentSessionEvent } from "./agent-session-types.js";

import {
	boundHostNoticeText,
	HOST_NOTICE_TYPE,
	type HostNotice,
	hostNoticeForEvent,
	hostNoticeMessage,
	reserveNoticeId,
} from "./host-notices.ts";
import type { CustomMessage } from "./messages.ts";
import { sessionGenerationClosing } from "./session-lifecycle-work.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/**
 * Saves the line `event` puts in the session's chat, if any, and returns its publisher (#5649). The entry
 * is queued before the event's listeners run, so anything they append comes after it, as it does on screen.
 */
export function recordHostNotice(session: AgentSession, event: AgentSessionEvent): (() => void) | undefined {
	// A closing session admits nothing more, and nothing follows it to show the line (#5649).
	if (session._disposed || sessionGenerationClosing.has(session)) return undefined;
	const found = hostNoticeForEvent(event, session._compactionReason);
	if (found === undefined) return undefined;
	const manager = session.sessionManager;
	const key = randomUUID();
	const label =
		event.type === "compaction_end"
			? event.aborted
				? "Compaction cancelled"
				: "Compaction failed"
			: event.type === "auto_retry_end"
				? event.finalError === "Retry cancelled"
					? "Retry cancelled"
					: "Retry failed"
				: event.type === "worktree_snapshot_unavailable"
					? "Checkout snapshot unavailable"
					: "Continuation failed";
	const notice: HostNotice = { level: found.level, text: boundHostNoticeText(found.text), label };
	const timestamp = Date.now();
	// A fixed label is already the complete row, even if its save fails. It never needs a preview.
	const fixed = found.text === label;
	const message = hostNoticeMessage({ ...found, label, ...(!fixed && { pendingId: key }) }, timestamp);
	let saved: Promise<string> | undefined;
	try {
		reserveNoticeId(notice, key);
		saved = manager.appendCustomEntry(HOST_NOTICE_TYPE, notice);
	} catch {
		// A session that can no longer be written still shows the line; it is lost with the session's other unsaved work.
	}
	const pending = unsaved.get(session) ?? new Map<string, CustomMessage<HostNotice>>();
	const finish = (entry?: SessionEntry) => {
		pending.delete(key);
		// A successful save must not replace the live diagnostic with the capped text from history.
		if (!fixed)
			session._emit({
				type: "message_end",
				message: hostNoticeMessage({ ...found, label, settlesId: key }, timestamp),
			});
		if (entry?.type === "custom" && session.sessionManager === manager)
			session._emit({ type: "entry_appended", entry: { ...entry, data: notice } });
	};
	if (saved !== undefined) {
		unsaved.set(session, pending);
		const announced = saved.then(
			(id) => finish(manager.getEntry(id)),
			() => finish(),
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
	return () => {
		// A redraw inside the outcome's listener precedes the line, just as it precedes its live message.
		if (saved !== undefined) pending.set(key, message);
		session._emit({ type: "message_start", message });
		if (fixed) session._emit({ type: "message_end", message });
		if (saved === undefined) finish();
	};
}

/** Lines a session has shown and is still saving, keyed by the data of the entry that saves each. */
const unsaved = new WeakMap<object, Map<string, CustomMessage<HostNotice>>>();

/** Whether `session` has shown a line it is still saving. */
export function hasUnsavedHostNotices(session: object): boolean {
	return (unsaved.get(session)?.size ?? 0) > 0;
}

/**
 * The lines `session` has shown but not yet saved, other than any among `entries`: a chat opened in that moment reads
 * them with the saved transcript, since the event that showed them has passed.
 */
export function unsavedHostNotices(session: object, entries: readonly SessionEntry[]): CustomMessage<HostNotice>[] {
	const pending = unsaved.get(session);
	if (pending === undefined || pending.size === 0) return [];
	const saved = new Set(
		entries.flatMap((entry) => (entry.type === "custom" && entry.customType === HOST_NOTICE_TYPE ? [entry.id] : [])),
	);
	return [...pending].flatMap(([key, message]) => (saved.has(key) ? [] : [message]));
}
