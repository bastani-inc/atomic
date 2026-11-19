import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	boundHostNoticeText,
	type HostNotice,
	hostNoticeFromEntry,
	hostNoticeFromMessage,
	isHostNoticeEntry,
} from "./host-notices.ts";
import type { CustomMessage } from "./messages.ts";
import type { CustomEntry, SessionEntry } from "./session-manager-types.ts";
import { readSessionRange } from "./storage/session/session-resume.js";
import type { SessionStore } from "./storage/session/types.js";

/** An ordinary status row is enough for the preview; the stored entry keeps the longer diagnostic. */
export const HOST_NOTICE_PREVIEW_BYTES = 192;
const WINDOW_BYTES = 2 * HOST_NOTICE_PREVIEW_BYTES;
const WINDOW_ROWS = 16;

/** A bounded FIFO of variable previews. Eviction leaves the factual row and its history location in place. */
export class HostNoticeWindow {
	private retained: { bytes: number; release: () => void }[] = [];
	private bytes = 0;

	keep(text: string, release: () => void, earlier = false): void {
		const bytes = Buffer.byteLength(text);
		this.bytes += bytes;
		if (earlier) this.retained.unshift({ bytes, release });
		else this.retained.push({ bytes, release });
		while (this.bytes > WINDOW_BYTES || this.retained.length > WINDOW_ROWS) {
			const oldest = this.retained.shift()!;
			this.bytes -= oldest.bytes;
			oldest.release();
		}
	}
}

const windows = new WeakMap<object, HostNoticeWindow>();

/** A view owns its copy: collapsing an older row must not mutate a session event or another view. */
export function retainTurnOutcome<T extends AgentMessage | CustomMessage>(
	owner: object,
	message: T,
	changed?: () => void,
	earlier = false,
): T {
	const notice = hostNoticeFromMessage(message);
	if (!notice?.location || notice.text === notice.label) return message;
	let window = windows.get(owner);
	if (!window) {
		window = new HostNoticeWindow();
		windows.set(owner, window);
	}
	const preview = noticePreview(notice);
	const copy = { ...message, content: preview.text, details: preview };
	window.keep(
		preview.text,
		() => {
			const text = preview.label ?? "Turn outcome";
			copy.details = { ...preview, text };
			copy.content = text;
			changed?.();
		},
		earlier,
	);
	return copy as T;
}

export function noticePreview(notice: HostNotice): HostNotice {
	return { ...notice, text: boundHostNoticeText(notice.text, HOST_NOTICE_PREVIEW_BYTES) };
}

interface NoticeSource {
	store: SessionStore;
	sessionId: string;
	seq: number;
}
const sources = new WeakMap<SessionEntry, NoticeSource>();

/** Store writes keep the full record. The manager's tree, branch and projections share this small, private copy. */
export function residentNotice(entry: SessionEntry, source: NoticeSource, window: HostNoticeWindow): SessionEntry {
	if (!isHostNoticeEntry(entry)) return entry;
	const notice = hostNoticeFromEntry(entry);
	if (!notice) return entry;
	const data = { ...noticePreview(notice), location: `history://sessions/${source.sessionId}?notice=${entry.id}` };
	const held = { ...entry, data } as CustomEntry<HostNotice>;
	sources.set(held, sources.get(entry) ?? source);
	window.keep(data.text, () => {
		held.data = { ...data, text: data.label ?? "Turn outcome" };
	});
	return held;
}

export function isResidentNotice(entry: SessionEntry): boolean {
	return sources.has(entry);
}

/** A history read, archive or fork copies the stored record, never the reader's preview. */
export async function storedNotice(entry: SessionEntry): Promise<SessionEntry> {
	const source = sources.get(entry);
	if (!source) return entry;
	const range = await readSessionRange(source.store, source.sessionId, source.seq, source.seq);
	const stored = range.entries[0];
	if (!stored || stored.id !== entry.id) throw new Error("Turn outcome is no longer at its recorded history location");
	return stored;
}

export async function storedNotices(entries: SessionEntry[]): Promise<SessionEntry[]> {
	if (!entries.some(isResidentNotice)) return entries;
	const result: SessionEntry[] = [];
	for (const entry of entries) result.push(isResidentNotice(entry) ? await storedNotice(entry) : entry);
	return result;
}
