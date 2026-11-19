import type { SessionEntry } from "../../session-manager-types.ts";
import type { SessionRecordHeader } from "./types.js";

/** Lightweight reader coordinate. A sliced task page must not pin the whole source reply it came from. */
export interface ChatPosition {
	id: string;
	parentId: string | null;
	role: "prompt" | "notice" | "other";
}
export function chatPosition(entry: SessionEntry): ChatPosition {
	return {
		id: entry.id,
		parentId: entry.parentId,
		role:
			entry.type === "message" && entry.message.role === "user"
				? "prompt"
				: entry.type === "custom_message" && entry.display && entry.excludeFromContext === true
					? "notice"
					: "other",
	};
}

/** Reader-only records never occupy a conversation entry, advance its leaf, or participate in model projection. */
export type ChatRecord =
	| {
			readonly kind: "line";
			readonly id?: string;
			readonly level: "dim" | "warning" | "error";
			readonly text: string;
			readonly childUnprefixed?: true;
	  }
	| { readonly kind: "promptBefore"; readonly promptId: string };
export const MAX_CHAT_LINE_BYTES = 4096;
const CUT = " … [diagnostic truncated]";
let graphemes: Intl.Segmenter | undefined;
/** The live event keeps the original text. A stored preview is bounded in UTF-8 bytes, including its marker. */
export function boundedChatRecord(record: ChatRecord): ChatRecord {
	if (
		record.kind !== "line" ||
		(record.text.length <= MAX_CHAT_LINE_BYTES && Buffer.byteLength(record.text) <= MAX_CHAT_LINE_BYTES)
	)
		return record;
	const budget = MAX_CHAT_LINE_BYTES - Buffer.byteLength(CUT);
	let bytes = 0,
		end = 0;
	graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const { segment, index } of graphemes.segment(record.text.slice(0, MAX_CHAT_LINE_BYTES + 1))) {
		bytes += Buffer.byteLength(segment);
		if (bytes > budget) break;
		end = index + segment.length;
	}
	// Detach a small slice from the provider's potentially very large response allocation.
	return { ...record, text: Buffer.from(record.text.slice(0, end), "utf16le").toString("utf16le") + CUT };
}
export interface AnchoredChatRecord {
	readonly anchor: string;
	readonly record: ChatRecord;
}
export interface ChatRecordOwner {
	readonly id: string;
	readonly epoch: string;
	readonly file?: string;
}
export interface SessionChatRecords {
	/** The empty anchor is the start of an empty conversation. Unknown record versions are ignored. */
	append(owner: ChatRecordOwner, anchor: string, record: ChatRecord): Promise<void>;
	/** One indexed, nonblocking question at mount. Reading a transcript for any other purpose never asks it. */
	has(owner: ChatRecordOwner): Promise<boolean>;
	read(owner: ChatRecordOwner, anchors: readonly string[]): Promise<readonly AnchoredChatRecord[]>;
}

/** An optional adapter can refuse synchronously or asynchronously. Neither failure replaces the original event. */
export function saveChatRecord(
	scope: { store: SessionChatRecords; owner: ChatRecordOwner },
	anchor: string,
	record: ChatRecord,
): void {
	try {
		void scope.store.append(scope.owner, anchor, record).catch(() => {});
	} catch {
		/* Display-only storage is best effort. */
	}
}

// Native full-history loaders return no epoch in their public snapshot. Keep the display reader's evidence on
// the particular header they returned, separately from the token that guards an ordinary conversation append.
const fullReadEpochs = new WeakMap<SessionRecordHeader, string>();
export function bindChatEpoch(header: SessionRecordHeader, epoch: string): void {
	fullReadEpochs.set(header, epoch);
}
export function chatEpoch(header: SessionRecordHeader): string | undefined {
	return fullReadEpochs.get(header);
}

export function decodeChatRecord(json: string): ChatRecord | undefined {
	try {
		const r = JSON.parse(json);
		if (r?.v !== 1) return undefined;
		if (
			r.kind === "line" &&
			(r.level === "error" || r.level === "warning" || r.level === "dim") &&
			typeof r.text === "string"
		)
			return {
				kind: "line",
				level: r.level,
				text: r.text,
				...(typeof r.id === "string" ? { id: r.id } : {}),
				...(r.childUnprefixed === true ? { childUnprefixed: true as const } : {}),
			};
		if (r.kind === "promptBefore" && typeof r.promptId === "string")
			return { kind: "promptBefore", promptId: r.promptId };
	} catch {
		/* An unreadable display record does not hide the conversation. */
	}
	return undefined;
}
