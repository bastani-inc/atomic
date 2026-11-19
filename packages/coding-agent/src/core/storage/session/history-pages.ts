import { hash } from "fast-sha256";
import { SessionConflictError } from "./errors.js";
import { snapshotChunk, snapshotHead, snapshotPage } from "./snapshot-cut.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionBranchSpan,
	type SessionHistoryPage,
	type SessionHistoryReadOptions,
	type SessionStore,
	yieldSessionTurn as yieldToEventLoop,
} from "./types.js";

export type SessionHistorySource =
	| SessionStore
	| Pick<SessionStore, "descriptor" | "readBranchSpan" | "readEntrySizes" | "readEntryChunk" | "readRange">;

function snapshotSource(store: SessionHistorySource): SessionStore {
	if ("load" in store) return store;
	throw new TypeError(`The selected ${store.descriptor.adapter} reader does not support this historical operation`);
}

function cursorScope(sessionId: string, epoch: string): string {
	return Buffer.from(hash(new TextEncoder().encode(JSON.stringify([sessionId, epoch])))).toString("base64url");
}

/** Start a portable iteration over the captured generation without reading its first page yet. */
export function firstHistoryCursor(sessionId: string, epoch: string, throughSeq: number): string {
	return `${cursorScope(sessionId, epoch)}.1.${throughSeq}`;
}

/** A lazy sequence of pages of the generation and watermark the caller observed. Metadata is sized before any
 * payload read. A new generation is rejected by readRange inside the same snapshot that reads the payload. */
export async function* historyPages(
	store: SessionHistorySource,
	sessionId: string,
	epoch: string | undefined,
	watermark: number,
	options: SessionHistoryReadOptions,
): AsyncGenerator<SessionHistoryPage, void> {
	const snapshotOnly = !store.readEntrySizes || !store.readRange;
	let cut = watermark;
	let cursorStamp: string | undefined;
	let leaf = options.branchLeafSeq;
	let start = Math.max(1, options.fromSeq ?? 1);
	let end = Math.min(watermark, options.toSeq ?? watermark, leaf ?? watermark);
	let firstSeq = start,
		lastSeq = end;
	let reverse = options.direction === "backward";
	let stamp = epoch;
	let scope = epoch === undefined ? undefined : cursorScope(sessionId, epoch);
	if (options.cursor !== undefined) {
		const match = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)(\.b)?(?:\.(\d+)\.(\d+))?(?:\.p(\d+))?(?:\.s(\d+))?$/.exec(
			options.cursor,
		);
		if (
			!match ||
			(!snapshotOnly && (match[1] !== scope || match[8] !== undefined)) ||
			options.fromSeq !== undefined ||
			options.toSeq !== undefined ||
			options.branchLeafSeq !== undefined ||
			(options.direction !== undefined && reverse !== Boolean(match[4]))
		)
			throw new TypeError("History cursor does not match this session, generation or range");
		cursorStamp = match[1];
		cut = match[8] === undefined ? watermark : Number(match[8]);
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
			!Number.isSafeInteger(cut) ||
			cut > watermark ||
			lastSeq > cut ||
			start > end
		)
			throw new TypeError("Invalid history cursor range");
	}
	if (leaf !== undefined && (!Number.isSafeInteger(leaf) || leaf < 1 || leaf > watermark || lastSeq > leaf))
		throw new RangeError("Branch history must start from a sequence in the captured session");
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1)
		throw new RangeError("History sequence must be a safe integer");
	// A scan asks for more entries a page, never more bytes, and reads a forward branch span once for its whole run:
	// the stored ancestry cannot change under a pinned generation, and every page's own reads still check it.
	const pageEntries = options.pageEntries ?? SESSION_HISTORY_PAGE_ENTRIES;
	if (!Number.isSafeInteger(pageEntries) || pageEntries < 1 || pageEntries > SESSION_HISTORY_SCAN_ENTRIES)
		throw new RangeError(`History pages hold from 1 to ${SESSION_HISTORY_SCAN_ENTRIES} entries`);
	const scan = options.pageEntries !== undefined;
	let pinned: SessionBranchSpan | undefined;
	while (start <= end) {
		options.signal?.throwIfAborted();
		const branchCut =
			leaf === undefined
				? undefined
				: { leaf, first: firstSeq, last: lastSeq, pivot: reverse ? end : start, backward: reverse, epoch: stamp };
		const span = !branchCut
			? undefined
			: pinned && start > pinned.start && start <= pinned.end
				? { start, end: pinned.end, older: true, newer: pinned.newer }
				: store.readBranchSpan
					? await store.readBranchSpan(sessionId, branchCut)
					: await (await import("./snapshot-history.js")).snapshotBranchSpan(
							snapshotSource(store),
							sessionId,
							branchCut,
						);
		if (scan && !reverse) pinned = span;
		if (leaf !== undefined) {
			options.signal?.throwIfAborted();
			if (!span) return;
		}
		const left = span?.start ?? start,
			right = span?.end ?? end;
		const from = reverse ? Math.max(left, right - pageEntries + 1) : left;
		const through = reverse ? right : Math.min(right, left + pageEntries - 1);
		let page: SessionHistoryPage["items"];
		let low: number, high: number;
		if (snapshotOnly) {
			const result = await snapshotPage(snapshotSource(store), sessionId, from, through, reverse, cut, stamp);
			options.signal?.throwIfAborted();
			stamp = result.epoch;
			scope = cursorScope(sessionId, stamp);
			if (cursorStamp && scope !== cursorStamp)
				throw new TypeError("History cursor does not match this session generation");
			page = result.items;
			low = page[0]!.seq;
			high = page[page.length - 1]!.seq;
		} else {
			const sized = scan
				? await store.readEntrySizes!(sessionId, from, through, pageEntries)
				: await store.readEntrySizes!(sessionId, from, through);
			options.signal?.throwIfAborted();
			stamp ??= sized.epoch;
			scope ??= cursorScope(sessionId, stamp);
			if (sized.epoch !== stamp || sized.lastSeq < end)
				throw new SessionConflictError(sessionId, watermark, sized.lastSeq);
			const ordered = reverse ? [...sized.sizes].reverse() : sized.sizes;
			const first = ordered[0];
			const edge = reverse ? through : from;
			if (!first || first.seq !== edge) throw new Error(`Missing session history at entry ${edge}`);
			low = high = edge;
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
				const range = await store.readRange!(sessionId, low, high, stamp);
				options.signal?.throwIfAborted();
				if (range.epoch !== stamp || range.lastSeq < end)
					throw new SessionConflictError(sessionId, watermark, range.lastSeq);
				page = range.entries.map((entry, i) => ({ seq: range.seqs?.[i] ?? low + i, entry }));
			}
		}
		if (reverse) end = low - 1;
		else start = high + 1;
		const hasOlder = span ? low > left || span.older : low > firstSeq;
		const hasNewer = span ? high < right || span.newer : high < lastSeq;
		const hasNext = reverse ? hasOlder : hasNewer;
		const cursorFor = (from: number, to: number, backward: boolean) =>
			`${scope}.${from}.${to}${backward ? ".b" : ""}${options.adjacent || leaf !== undefined ? `.${firstSeq}.${lastSeq}` : ""}${leaf === undefined ? "" : `.p${leaf}`}${snapshotOnly ? `.s${cut}` : ""}`;
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

/** Find the last exact stored position in pages visited newest first. An opaque oversized item cannot
 * be skipped without checking its identity: an older row could reuse its ID. No body is assembled. */
export async function findInSessionHistory(
	pages: AsyncIterable<SessionHistoryPage>,
	id: string,
	chunks?: (item: OversizedSessionEntry) => AsyncIterable<Uint8Array>,
	signal?: AbortSignal,
): Promise<number | undefined> {
	for await (const { items } of pages) {
		signal?.throwIfAborted();
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			if ("entry" in item) {
				if (item.entry.id === id) return item.seq;
			} else {
				if (!chunks) return undefined;
				if (await (await import("./chunked-resume-projection.js")).chunkedEntryHasId(chunks(item), id))
					return item.seq;
			}
		}
	}
	return undefined;
}

/** Read an existing saved session without creating a live session manager, model context or recovery bindings. */
export async function* readSessionHistory(
	store: SessionStore,
	sessionId: string,
	options: SessionHistoryReadOptions = {},
): AsyncGenerator<SessionHistoryPage, void> {
	options.signal?.throwIfAborted();
	const head =
		store.readEntrySizes && store.readRange
			? await store.readEntrySizes(sessionId, 1, 0)
			: await snapshotHead(store, sessionId);
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
	store: SessionHistorySource,
	sessionId: string,
	epoch: string | undefined,
	reference: OversizedSessionEntry,
	options: { readonly offset?: number; readonly signal?: AbortSignal },
): AsyncGenerator<Uint8Array, void> {
	if (
		reference.sessionId !== sessionId ||
		(store.readEntrySizes && store.readRange && epoch !== undefined && reference.epoch !== epoch)
	)
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
		const data =
			store.readEntryChunk && store.readEntrySizes && store.readRange
				? await store.readEntryChunk(reference, offset)
				: await snapshotChunk(snapshotSource(store), reference, offset);
		options.signal?.throwIfAborted();
		if (!data.length || data.length > SESSION_HISTORY_CHUNK_BYTES || offset + data.length > reference.bytes)
			throw new Error(`Incomplete or invalid historical entry ${reference.seq}`);
		offset += data.length;
		yield data;
		if (offset < reference.bytes) await yieldToEventLoop();
	}
}
