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
/** Copies text into a string of its own, so a kept preview never pins the larger string it was sliced from. */
const detached = (text: string) => Buffer.from(text, "utf16le").toString("utf16le");
/** The live event keeps the original text. A stored preview is bounded in UTF-8 bytes, including its marker. */
export function boundedChatRecord(record: ChatRecord): ChatRecord {
	if (record.kind !== "line") return record;
	if (record.text.length <= MAX_CHAT_LINE_BYTES && Buffer.byteLength(record.text) <= MAX_CHAT_LINE_BYTES)
		return { ...record, text: detached(record.text) };
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
	return { ...record, text: detached(record.text.slice(0, end)) + CUT };
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
/** A prompt shown before the chain of notices starting at `anchor`, which it was persisted after. */
export interface ChatOrder {
	readonly anchor: string;
	readonly promptId: string;
}
export interface SessionChatRecords {
	/**
	 * The empty anchor is the start of an empty conversation. Unknown record versions are ignored. A `promptBefore`
	 * record also indexes its edge by prompt, in the same write where the backend can make it one.
	 */
	append(owner: ChatRecordOwner, anchor: string, record: ChatRecord): Promise<void>;
	/** One indexed, nonblocking question at mount. Reading a transcript for any other purpose never asks it. */
	has(owner: ChatRecordOwner): Promise<boolean>;
	read(owner: ChatRecordOwner, anchors: readonly string[]): Promise<readonly AnchoredChatRecord[]>;
	/**
	 * Metadata only: the first saved edge of each of `promptIds` that has one, found from the prompt alone. It never
	 * reads a diagnostic body, so a reader whose first notice is offscreen still learns where its prompt was shown.
	 */
	readOrders?(owner: ChatRecordOwner, promptIds: readonly string[]): Promise<readonly ChatOrder[]>;
}

/** The reverse edge's own record: never a `ChatRecord`, so an anchored read skips it. */
export function encodeChatOrder(order: ChatOrder): string {
	return JSON.stringify({ v: 1, kind: "order", anchor: order.anchor, promptId: order.promptId });
}
export function decodeChatOrder(json: string): ChatOrder | undefined {
	try {
		const r = JSON.parse(json);
		if (r?.v === 1 && r.kind === "order" && typeof r.anchor === "string" && typeof r.promptId === "string")
			return { anchor: r.anchor, promptId: r.promptId };
	} catch {
		/* An unreadable edge only loses its hint. */
	}
	return undefined;
}
/** Keeps the first saved edge of each requested prompt, in the order they were saved. */
export function firstChatOrders(orders: Iterable<ChatOrder>, promptIds: readonly string[]): ChatOrder[] {
	const wanted = new Set(promptIds),
		seen = new Set<string>(),
		result: ChatOrder[] = [];
	for (const order of orders)
		if (wanted.has(order.promptId) && !seen.has(order.promptId)) {
			seen.add(order.promptId);
			result.push(order);
		}
	return result;
}

/** An optional adapter can refuse synchronously or asynchronously. Neither failure replaces the original event. */
export function saveChatRecord(
	scope: { store: SessionChatRecords; owner: ChatRecordOwner },
	anchor: string,
	record: ChatRecord,
): Promise<void> | undefined {
	try {
		return scope.store.append(scope.owner, anchor, record).catch(() => {});
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
