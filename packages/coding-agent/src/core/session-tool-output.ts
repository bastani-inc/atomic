import { Buffer } from "node:buffer";
import type { SessionStore } from "./storage/session/types.js";
import type { PersistToolOutput } from "./tools/oversized-tool-result.ts";

/** The `customType` of the entry that records a tool output kept as a blob of its session. */
export const TOOL_OUTPUT_ENTRY_TYPE = "atomic.tool-output";

const TOOL_OUTPUT_URL_PREFIX = "tool-output://";

/** What a tool-output entry records. */
export interface ToolOutputReference {
	readonly toolCallId: string;
	/** The lowercase hex SHA-256 of the blob. */
	readonly hash: string;
	readonly bytes: number;
}

/** The URL the model reads a tool output kept as a session blob from. */
export function toolOutputUrl(hash: string): string {
	return `${TOOL_OUTPUT_URL_PREFIX}${hash}`;
}

/** The hash a `tool-output://` URL names, or `undefined` for a URL of another scheme. */
export function toolOutputUrlHash(url: string): string | undefined {
	return url.startsWith(TOOL_OUTPUT_URL_PREFIX) ? url.slice(TOOL_OUTPUT_URL_PREFIX.length) : undefined;
}

/**
 * Keeps a released stage's oversized output as a blob of its session, when the session's store holds blobs: the
 * blob first, then an entry referencing it, so a process that stops in between leaves only a blob of that session.
 * Resolves with the `tool-output://` URL the model reads it from. Undefined when the store holds no blobs.
 */
export function sessionBlobOutput(
	manager: {
		getSessionStore(): SessionStore;
		getSessionId(): string;
		appendCustomEntry(customType: string, data: ToolOutputReference): Promise<string>;
	},
	toolCallId: string,
): PersistToolOutput | undefined {
	const store = manager.getSessionStore();
	const putBlob = store.putBlob;
	if (putBlob === undefined) return undefined;
	return async (stored) => {
		const blob = await putBlob.call(store, manager.getSessionId(), Buffer.from(stored));
		await manager.appendCustomEntry(TOOL_OUTPUT_ENTRY_TYPE, { toolCallId, hash: blob.hash, bytes: blob.bytes });
		return { location: toolOutputUrl(blob.hash), sha256: blob.hash };
	};
}
