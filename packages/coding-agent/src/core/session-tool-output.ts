import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { SessionEntry } from "./session-manager-types.ts";
import { attachCleanupCause } from "./storage/cleanup.js";
import { SessionBlobError } from "./storage/errors.js";
import type { SessionStore } from "./storage/session/types.js";
import type { PersistToolOutput } from "./tools/oversized-tool-result.ts";

/** The `customType` of the entry that records a tool output kept as a blob of its session. */
export const TOOL_OUTPUT_ENTRY_TYPE = "atomic.tool-output";

const TOOL_OUTPUT_URL_PREFIX = "tool-output://";

/** What a tool-output entry records. An exported session also carries the blob's bytes, as `base64`. */
export interface ToolOutputReference {
	readonly toolCallId: string;
	/** The lowercase hex SHA-256 of the blob. */
	readonly hash: string;
	readonly bytes: number;
	/** Only in an exported session: the blob's bytes, so the file restores without the storage it came from. */
	readonly base64?: string;
}

/** A blob's bytes on their way from one session to another, under the hash they are stored by. */
export interface SessionBlobCopy {
	readonly hash: string;
	readonly data: Uint8Array;
}

/** The URL the model reads a tool output kept as a session blob from. */
export function toolOutputUrl(hash: string): string {
	return `${TOOL_OUTPUT_URL_PREFIX}${hash}`;
}

/** The hash a `tool-output://` URL names, or `undefined` for a URL of another scheme. */
export function toolOutputUrlHash(url: string): string | undefined {
	return url.startsWith(TOOL_OUTPUT_URL_PREFIX) ? url.slice(TOOL_OUTPUT_URL_PREFIX.length) : undefined;
}

function referenceOf(entry: SessionEntry): ToolOutputReference | undefined {
	if (entry.type !== "custom" || entry.customType !== TOOL_OUTPUT_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<ToolOutputReference> | null | undefined;
	return typeof data?.hash === "string" ? (data as ToolOutputReference) : undefined;
}

/** Every blob hash the tool-output entries among `entries` reference, each once, in entry order. */
export function toolOutputHashes(entries: readonly SessionEntry[]): string[] {
	return [...new Set(entries.flatMap((entry) => referenceOf(entry)?.hash ?? []))];
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

/**
 * The hashes of the stored tool outputs a copy of `entries` from `store` brings along: each one the entries reference,
 * once, when `store` holds blobs, and none when it does not.
 */
export function sessionBlobHashes(store: SessionStore, entries: readonly SessionEntry[]): string[] {
	return store.getBlob === undefined ? [] : toolOutputHashes(entries);
}

/**
 * Throws `blobs-unsupported` when there are `blobCount` blobs to store and `store` cannot hold them. Call it before
 * writing anything, so a copy that cannot keep its blobs fails without leaving a session behind.
 */
export function assertSessionBlobStore(store: SessionStore, sessionId: string, blobCount: number): void {
	if (blobCount > 0 && store.putBlob === undefined) {
		throw new SessionBlobError("blobs-unsupported", { sessionId, adapter: store.descriptor.adapter });
	}
}

/** Runs `write` for a session just created in `store`; when it fails, the session is deleted again. */
async function writeOrDelete(store: SessionStore, sessionId: string, write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch (error) {
		await store.delete(sessionId).catch((cleanupCause: unknown) => attachCleanupCause(error, cleanupCause));
		throw error;
	}
}

/**
 * Stores `blobs` for a session just created in `store`. When the store cannot hold them or one cannot be stored, the
 * session is deleted again and the failure thrown, with a failure to delete attached as its `cleanupCause`.
 */
export function storeSessionBlobs(
	store: SessionStore,
	sessionId: string,
	blobs: readonly SessionBlobCopy[],
): Promise<void> {
	return writeOrDelete(store, sessionId, async () => {
		assertSessionBlobStore(store, sessionId, blobs.length);
		for (const blob of blobs) await store.putBlob!(sessionId, blob.data);
	});
}

/**
 * Copies the blobs `hashes` names from a session in `source` to a session just created in `target`, one at a time, so
 * a copy never holds more than one blob in memory. A blob the source no longer holds is skipped. When the target
 * cannot hold blobs or one cannot be copied, the target session is deleted again and the failure thrown, with a
 * failure to delete attached as its `cleanupCause`.
 */
export function copySessionBlobs(
	source: SessionStore,
	sourceSessionId: string,
	target: SessionStore,
	targetSessionId: string,
	hashes: readonly string[],
): Promise<void> {
	return writeOrDelete(target, targetSessionId, async () => {
		assertSessionBlobStore(target, targetSessionId, hashes.length);
		for (const hash of hashes) {
			const data = await source.getBlob?.(sourceSessionId, hash);
			if (data !== undefined) await target.putBlob!(targetSessionId, data);
		}
	});
}

/**
 * `entries` with the bytes of each tool output `store` holds for the session carried inline, each once, so an
 * exported file restores without the storage. An output the store no longer holds keeps only its reference.
 */
export async function inlineToolOutput(
	entries: readonly SessionEntry[],
	store: SessionStore,
	sessionId: string,
): Promise<SessionEntry[]> {
	const carried = new Set<string>();
	const inlined: SessionEntry[] = [];
	for (const entry of entries) {
		const reference = referenceOf(entry);
		if (reference === undefined || carried.has(reference.hash)) {
			inlined.push(entry);
			continue;
		}
		const data = await store.getBlob?.(sessionId, reference.hash);
		if (data === undefined) {
			inlined.push(entry);
			continue;
		}
		carried.add(reference.hash);
		inlined.push({ ...entry, data: { ...reference, base64: Buffer.from(data).toString("base64") } } as SessionEntry);
	}
	return inlined;
}

/**
 * Takes the tool outputs an exported session carries inline out of its entries, after checking each against its
 * hash. Throws `blob-corrupt` for the first that does not match, before anything is written.
 */
export function takeInlineToolOutput(
	entries: readonly SessionEntry[],
	sessionId: string,
): { readonly entries: SessionEntry[]; readonly blobs: SessionBlobCopy[] } {
	const blobs = new Map<string, SessionBlobCopy>();
	const taken = entries.map((entry) => {
		const reference = referenceOf(entry);
		if (typeof reference?.base64 !== "string") return entry;
		const { base64, ...kept } = reference;
		const data = new Uint8Array(Buffer.from(base64, "base64"));
		const actualHash = createHash("sha256").update(data).digest("hex");
		if (actualHash !== reference.hash) {
			throw new SessionBlobError("blob-corrupt", { sessionId, hash: reference.hash, actualHash });
		}
		blobs.set(actualHash, { hash: actualHash, data });
		return { ...entry, data: kept } as SessionEntry;
	});
	return { entries: taken, blobs: [...blobs.values()] };
}
