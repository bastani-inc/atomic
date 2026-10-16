import type { SessionStore } from "@bastani/atomic";

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
		const snapshot = await store.load(sessionId);
		return snapshot.header.id === sessionId && snapshot.entries.some(isUsableContextMessage);
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
