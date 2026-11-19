import type { SessionStore } from "@bastani/atomic";
import { readSessionHistory, readSessionHistoryChunks } from "@bastani/atomic/storage";

interface SessionTranscriptEntry {
	readonly type?: string;
	readonly id?: string;
	readonly timestamp?: string;
	readonly message?: {
		readonly role?: string;
		readonly content?: string | object;
	};
}

export async function isReopenableSession(store: SessionStore, sessionId: string): Promise<boolean> {
	try {
		if ((await store.readHeader(sessionId))?.id !== sessionId) return false;
		for await (const { items } of readSessionHistory(store, sessionId)) {
			for (const item of items) {
				if ("entry" in item) {
					if (isUsableContextMessage(item.entry)) return true;
				} else {
					const { hasUsableMessageInChunks } = await import("./session-transcript-chunks.js");
					if (await hasUsableMessageInChunks(readSessionHistoryChunks(store, item))) return true;
				}
			}
		}
		return false;
	} catch {
		return false;
	}
}

function isUsableContextMessage(entry: SessionTranscriptEntry): boolean {
	return (
		entry.type === "message" &&
		typeof entry.id === "string" &&
		typeof entry.timestamp === "string" &&
		typeof entry.message?.role === "string" &&
		hasUsableMessageContent(entry.message.content)
	);
}

function hasUsableMessageContent(content: string | object | undefined): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	return Array.isArray(content) && content.some(hasUsableContentBlock);
}

function hasUsableContentBlock(block: object): boolean {
	if (typeof block !== "object" || block === null) return false;
	const contentBlock = block as {
		readonly text?: string;
		readonly thinking?: string;
		readonly data?: string;
		readonly name?: string;
	};
	return [contentBlock.text, contentBlock.thinking, contentBlock.data, contentBlock.name].some(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
}
