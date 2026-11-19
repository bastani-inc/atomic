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

/** Start a portable iteration over the captured generation without reading its first page yet. */
export function firstHistoryCursor(sessionId: string, epoch: string, throughSeq: number): string {
	return `${cursorScope(sessionId, epoch)}.1.${throughSeq}`;
}

/** A lazy sequence of pages of the generation and watermark the caller observed. Metadata is sized before any
 * payload read. A new generation is rejected by readRange inside the same snapshot that reads the payload. */
export async function* historyPages(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	watermark: number,
	options: SessionHistoryReadOptions,
): AsyncGenerator<SessionHistoryPage, void> {
	if (!store.readEntrySizes || !store.readRange)
		throw new TypeError(
			`Session store ${store.descriptor.adapter} must implement bounded history reads (readEntrySizes and readRange)`,
		);
	let leaf = options.branchLeafSeq;
	let start = Math.max(1, options.fromSeq ?? 1);
	let end = Math.min(watermark, options.toSeq ?? watermark, leaf ?? watermark);
	let firstSeq = start,
		lastSeq = end;
	let reverse = options.direction === "backward";
	let stamp = epoch;
	let scope = epoch === undefined ? undefined : cursorScope(sessionId, epoch);
	if (options.cursor !== undefined) {
		const match = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)(\.b)?(?:\.(\d+)\.(\d+))?(?:\.p(\d+))?$/.exec(options.cursor);
		if (
			!match ||
			match[1] !== scope ||
			options.fromSeq !== undefined ||
			options.toSeq !== undefined ||
			options.branchLeafSeq !== undefined ||
			(options.direction !== undefined && reverse !== Boolean(match[4]))
		)
			throw new TypeError("History cursor does not match this session, generation or range");
		leaf = match[7] === undefined ? undefined : Number(match[7]);
		start = Number(match[2]);
		end = Number(match[3]);
		reverse = Boolean(match[4]);
		firstSeq = match[5] === undefined ? start : Number(match[5]);
		lastSeq = match[6] === undefined ? end : Number(match[6]);
		if (
			!Number.isSafeInteger(firstSeq) ||
			!Number.isSafeInteger(lastSeq) ||
			firstSeq < 1 ||
			firstSeq > start ||
			lastSeq < end ||
			lastSeq > watermark ||
			start > end
		)
			throw new TypeError("Invalid history cursor range");
	}
	if (leaf !== undefined && (!Number.isSafeInteger(leaf) || leaf < 1 || leaf > watermark || lastSeq > leaf))
		throw new RangeError("Branch history must start from a sequence in the captured session");
	if (leaf !== undefined && !store.readBranchSpan)
		throw new TypeError(`Session store ${store.descriptor.adapter} must implement readBranchSpan`);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1)
		throw new RangeError("History sequence must be a safe integer");
	while (start <= end) {
		options.signal?.throwIfAborted();
		const span =
			leaf === undefined
				? undefined
				: await store.readBranchSpan!(sessionId, {
						leaf,
						first: firstSeq,
						last: lastSeq,
						pivot: reverse ? end : start,
						backward: reverse,
						epoch: stamp,
					});
		if (leaf !== undefined) {
			options.signal?.throwIfAborted();
			if (!span) return;
		}
		const left = span?.start ?? start,
			right = span?.end ?? end;
		const from = reverse ? Math.max(left, right - SESSION_HISTORY_PAGE_ENTRIES + 1) : left;
		const through = reverse ? right : Math.min(right, left + SESSION_HISTORY_PAGE_ENTRIES - 1);
		const sized = await store.readEntrySizes(sessionId, from, through);
		options.signal?.throwIfAborted();
		stamp ??= sized.epoch;
		scope ??= cursorScope(sessionId, stamp);
		if (sized.epoch !== stamp || sized.lastSeq < end)
			throw new SessionConflictError(sessionId, watermark, sized.lastSeq);
		const ordered = reverse ? [...sized.sizes].reverse() : sized.sizes;
		const first = ordered[0];
		const edge = reverse ? through : from;
		if (!first || first.seq !== edge) throw new Error(`Missing session history at entry ${edge}`);
		let page: SessionHistoryPage["items"];
		let low = edge,
			high = edge;
		if (first.bytes > SESSION_HISTORY_PAGE_BYTES) {
			page = [{ kind: "oversized", sessionId, epoch: stamp, seq: edge, bytes: first.bytes }];
		} else {
			let used = 0;
			for (const size of ordered) {
				if (used + size.bytes > SESSION_HISTORY_PAGE_BYTES) break;
				used += size.bytes;
				if (reverse) low = size.seq;
				else high = size.seq;
			}
			const range = await store.readRange(sessionId, low, high, stamp);
			options.signal?.throwIfAborted();
			if (range.epoch !== stamp || range.lastSeq < end)
				throw new SessionConflictError(sessionId, watermark, range.lastSeq);
			page = range.entries.map((entry, i) => ({ seq: range.seqs?.[i] ?? low + i, entry }));
		}
		if (reverse) end = low - 1;
		else start = high + 1;
		const hasOlder = span ? low > left || span.older : low > firstSeq;
		const hasNewer = span ? high < right || span.newer : high < lastSeq;
		const hasNext = reverse ? hasOlder : hasNewer;
		const cursorFor = (from: number, to: number, backward: boolean) =>
			`${scope}.${from}.${to}${backward ? ".b" : ""}${options.adjacent || leaf !== undefined ? `.${firstSeq}.${lastSeq}` : ""}${leaf === undefined ? "" : `.p${leaf}`}`;
		yield {
			items: page,
			...(hasNext ? { nextCursor: cursorFor(start, end, reverse) } : {}),
			...(options.adjacent
				? {
						adjacent: {
							...(hasOlder ? { older: cursorFor(firstSeq, low - 1, true) } : {}),
							...(hasNewer ? { newer: cursorFor(high + 1, lastSeq, false) } : {}),
						},
					}
				: {}),
		};
		if (!hasNext) return;
		await yieldToEventLoop();
	}
}

/** Read an existing saved session without creating a live session manager, model context or recovery bindings. */
export async function* readSessionHistory(
	store: SessionStore,
	sessionId: string,
	options: SessionHistoryReadOptions = {},
): AsyncGenerator<SessionHistoryPage, void> {
	if (!store.readEntrySizes)
		throw new TypeError(
			`Session store ${store.descriptor.adapter} must implement readEntrySizes for a history reader`,
		);
	options.signal?.throwIfAborted();
	const head = await store.readEntrySizes(sessionId, 1, 0);
	options.signal?.throwIfAborted();
	yield* historyPages(store, sessionId, head.epoch, head.lastSeq, options);
}

export function readSessionHistoryChunks(
	store: SessionStore,
	reference: OversizedSessionEntry,
	options: { readonly offset?: number; readonly signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array, void> {
	return historyChunks(store, reference.sessionId, reference.epoch, reference, options);
}

export async function* historyChunks(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	reference: OversizedSessionEntry,
	options: { readonly offset?: number; readonly signal?: AbortSignal },
): AsyncGenerator<Uint8Array, void> {
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
