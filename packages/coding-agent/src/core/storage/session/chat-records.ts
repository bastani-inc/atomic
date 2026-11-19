import type { SessionRecordHeader } from "./types.js";

/** Reader-only records never occupy a conversation entry, advance its leaf, or participate in model projection. */
export type ChatRecord =
	| { readonly kind: "line"; readonly level: "dim" | "warning" | "error"; readonly text: string }
	| { readonly kind: "promptBefore"; readonly promptId: string };
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
			return { kind: "line", level: r.level, text: r.text };
		if (r.kind === "promptBefore" && typeof r.promptId === "string")
			return { kind: "promptBefore", promptId: r.promptId };
	} catch {
		/* An unreadable display record does not hide the conversation. */
	}
	return undefined;
}
