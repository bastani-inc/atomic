import { createHash } from "node:crypto";
import { yieldToEventLoop } from "../../../utils/event-loop.js";
import { SessionConflictError } from "./errors.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionHistoryPage,
	type SessionHistoryReadOptions,
	type SessionStore,
} from "./types.js";

function cursorScope(sessionId: string, epoch: string): string {
	return createHash("sha256")
		.update(JSON.stringify([sessionId, epoch]))
		.digest("base64url");
}

/** A lazy sequence of pages of the generation and watermark the caller observed. Metadata is sized before any
 * payload read. A new generation is rejected by readRange inside the same snapshot that reads the payload. */
export async function* historyPages(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	watermark: number,
	options: SessionHistoryReadOptions,
): AsyncGenerator<SessionHistoryPage> {
	if (!store.readEntrySizes || !store.readRange)
		throw new TypeError(
			`Session store ${store.descriptor.adapter} must implement bounded history reads (readEntrySizes and readRange)`,
		);
	let start = Math.max(1, options.fromSeq ?? 1);
	let end = Math.min(watermark, options.toSeq ?? watermark);
	let stamp = epoch;
	let scope = epoch === undefined ? undefined : cursorScope(sessionId, epoch);
	if (options.cursor !== undefined) {
		const match = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/.exec(options.cursor);
		if (!match || match[1] !== scope || options.fromSeq !== undefined || options.toSeq !== undefined)
			throw new TypeError("History cursor does not match this session, generation or range");
		start = Number(match[2]);
		end = Number(match[3]);
		if (end > watermark || start > end) throw new TypeError("Invalid history cursor range");
	}
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1)
		throw new RangeError("History sequence must be a safe integer");
	while (start <= end) {
		options.signal?.throwIfAborted();
		const through = Math.min(end, start + SESSION_HISTORY_PAGE_ENTRIES - 1);
		const sized = await store.readEntrySizes(sessionId, start, through);
		options.signal?.throwIfAborted();
		stamp ??= sized.epoch;
		scope ??= cursorScope(sessionId, stamp);
		if (sized.epoch !== stamp || sized.lastSeq < end)
			throw new SessionConflictError(sessionId, watermark, sized.lastSeq);
		const first = sized.sizes[0];
		if (!first || first.seq !== start) throw new Error(`Missing session history at entry ${start}`);
		let page: SessionHistoryPage["items"];
		if (first.bytes > SESSION_HISTORY_PAGE_BYTES) {
			page = [{ kind: "oversized", sessionId, epoch: stamp, seq: start, bytes: first.bytes }];
			start++;
		} else {
			let used = 0;
			let last = first.seq;
			for (const size of sized.sizes) {
				if (used + size.bytes > SESSION_HISTORY_PAGE_BYTES) break;
				used += size.bytes;
				last = size.seq;
			}
			const range = await store.readRange(sessionId, start, last, stamp);
			options.signal?.throwIfAborted();
			if (range.epoch !== stamp || range.lastSeq < end)
				throw new SessionConflictError(sessionId, watermark, range.lastSeq);
			page = range.entries.map((entry, i) => ({ seq: range.seqs?.[i] ?? start + i, entry }));
			start = last + 1;
		}
		yield { items: page, ...(start <= end ? { nextCursor: `${scope}.${start}.${end}` } : {}) };
		if (start <= end) await yieldToEventLoop();
	}
}

export async function* historyChunks(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	reference: OversizedSessionEntry,
	options: { readonly offset?: number; readonly signal?: AbortSignal },
): AsyncGenerator<Uint8Array> {
	if (!store.readEntryChunk)
		throw new TypeError(`Session store ${store.descriptor.adapter} must implement readEntryChunk`);
	if (reference.sessionId !== sessionId || (epoch !== undefined && reference.epoch !== epoch))
		throw new TypeError("Historical entry reference does not match this session generation");
	let offset = options.offset ?? 0;
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(reference.bytes) ||
		offset > reference.bytes ||
		!Number.isSafeInteger(reference.seq) ||
		reference.seq < 1
	)
		throw new RangeError("Invalid historical entry byte range");
	while (offset < reference.bytes) {
		options.signal?.throwIfAborted();
		const data = await store.readEntryChunk(reference, offset);
		options.signal?.throwIfAborted();
		if (!data.length || data.length > SESSION_HISTORY_CHUNK_BYTES || offset + data.length > reference.bytes)
			throw new Error(`Incomplete or invalid historical entry ${reference.seq}`);
		offset += data.length;
		yield data;
		if (offset < reference.bytes) await yieldToEventLoop();
	}
}
