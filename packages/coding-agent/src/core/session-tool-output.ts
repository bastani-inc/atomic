import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { SessionEntry } from "./session-manager-types.ts";
import { attachCleanupCause } from "./storage/cleanup.js";
import { SessionBlobError } from "./storage/errors.js";
import type { SessionBlob, SessionStore } from "./storage/session/types.js";
import type { PersistToolOutput } from "./tools/oversized-tool-result.js";

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

/** A blob on its way from an exported session into another, under the hash it is stored by. */
export interface SessionBlobCopy {
	readonly hash: string;
	/** The blob's bytes, produced when asked for, so a copy holds one blob at a time and not all of them. */
	readonly read: () => Uint8Array;
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
 * blob first, then an entry referencing it, as one mutation of the manager, so a session change cannot come between
 * them and a process that stops in between leaves only a blob of that session. Resolves with the `tool-output://`
 * URL the model reads it from. Undefined when the store holds no blobs.
 */
export function sessionBlobOutput(
	manager: {
		getSessionStore(): SessionStore;
		appendToolOutputBlob(toolCallId: string, data: Uint8Array): Promise<SessionBlob>;
	},
	toolCallId: string,
): PersistToolOutput | undefined {
	if (manager.getSessionStore().putBlob === undefined) return undefined;
	return async (stored) => {
		const blob = await manager.appendToolOutputBlob(toolCallId, Buffer.from(stored));
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
		for (const blob of blobs) await store.putBlob!(sessionId, blob.read());
	});
}

/** Told once per copy or export when blobs its entries reference were not in the source; see {@link BlobCopyOptions}. */
export type MissingBlobReporter = (error: SessionBlobError) => void;

export interface BlobCopyOptions {
	/**
	 * Called once, with a `blob-missing` error naming the first missing hash and how many were missing, when the source
	 * no longer holds blobs its entries reference. The copy or export goes on without them. Default:
	 * `process.emitWarning`. A listener that throws does not change the outcome; its own error becomes a process warning.
	 */
	readonly onMissingBlob?: MissingBlobReporter;
}

function reportMissingBlobs(options: BlobCopyOptions, sessionId: string, missing: readonly string[]): void {
	if (missing.length === 0) return;
	const error = new SessionBlobError("blob-missing", { sessionId, hash: missing[0], missing: missing.length });
	try {
		(options.onMissingBlob ?? ((reported) => process.emitWarning(reported)))(error);
	} catch (listenerError) {
		process.emitWarning(listenerError instanceof Error ? listenerError : new Error(String(listenerError)));
	}
}

/**
 * Copies the blobs `hashes` names from a session in `source` to a session just created in `target`, one at a time, so
 * a copy never holds more than one blob in memory. A blob the source no longer holds is skipped and reported once
 * through `onMissingBlob`. When the target cannot hold blobs or one cannot be copied, the target session is deleted
 * again and the failure thrown, with a failure to delete attached as its `cleanupCause`.
 */
export function copySessionBlobs(
	source: SessionStore,
	sourceSessionId: string,
	target: SessionStore,
	targetSessionId: string,
	hashes: readonly string[],
	options: BlobCopyOptions = {},
): Promise<void> {
	return writeOrDelete(target, targetSessionId, async () => {
		assertSessionBlobStore(target, targetSessionId, hashes.length);
		const missing: string[] = [];
		for (const hash of hashes) {
			const data = await source.getBlob?.(sourceSessionId, hash);
			if (data === undefined) missing.push(hash);
			else await target.putBlob!(targetSessionId, data);
		}
		reportMissingBlobs(options, sourceSessionId, missing);
	});
}

/**
 * `entries`, one at a time, each tool output `store` holds for the session carried inline once, so an exported file
 * restores without the storage. A blob is read when its entry is reached and not kept, so an export holds one output
 * at a time however many a session has. An output the store no longer holds keeps only its reference, and is reported
 * once, after the last entry, through `onMissingBlob`.
 */
export async function* inlineToolOutput(
	entries: readonly SessionEntry[],
	store: SessionStore,
	sessionId: string,
	options: BlobCopyOptions = {},
): AsyncGenerator<SessionEntry, void> {
	const seen = new Set<string>();
	const missing: string[] = [];
	for (const entry of entries) {
		const reference = referenceOf(entry);
		if (store.getBlob === undefined || reference === undefined || seen.has(reference.hash)) {
			yield entry;
			continue;
		}
		seen.add(reference.hash);
		const data = await store.getBlob(sessionId, reference.hash);
		if (data === undefined) {
			missing.push(reference.hash);
			yield entry;
			continue;
		}
		yield { ...entry, data: { ...reference, base64: Buffer.from(data).toString("base64") } } as SessionEntry;
	}
	reportMissingBlobs(options, sessionId, missing);
}

/** `entries` without the bytes any tool-output entry carries inline, so an export for sharing holds only previews. */
export function withoutInlineToolOutput(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map((entry) => {
		const reference = referenceOf(entry);
		if (reference?.base64 === undefined) return entry;
		const { base64: _carried, ...kept } = reference;
		return { ...entry, data: kept } as SessionEntry;
	});
}

/**
 * Takes the tool outputs an exported session carries inline out of its entries, after checking each against its
 * hash. Throws `blob-corrupt` for the first that does not match, before anything is written. Each output is decoded
 * for the check and dropped, and again when it is stored, so an import holds one decoded output at a time.
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
		const decode = () => new Uint8Array(Buffer.from(base64, "base64"));
		const actualHash = createHash("sha256").update(decode()).digest("hex");
		if (actualHash !== reference.hash) {
			throw new SessionBlobError("blob-corrupt", { sessionId, hash: reference.hash, actualHash });
		}
		blobs.set(actualHash, { hash: actualHash, read: decode });
		return { ...entry, data: kept } as SessionEntry;
	});
	return { entries: taken, blobs: [...blobs.values()] };
}
