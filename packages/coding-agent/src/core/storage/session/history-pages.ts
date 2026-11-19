import { hash } from "fast-sha256";
import { SessionConflictError } from "./errors.js";
import {
	type HistoryPacketReader,
	historySnapshotFor,
	observeReferenceCut,
	referenceMetadataRead,
} from "./history-snapshot.js";
import { snapshotChunk, snapshotHead, snapshotPage } from "./snapshot-cut.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	type SessionHistoryPage,
	type SessionHistoryReadOptions,
	type SessionStore,
	yieldSessionTurn as yieldToEventLoop,
} from "./types.js";

function cursorScope(sessionId: string, epoch: string): string {
	return Buffer.from(hash(new TextEncoder().encode(JSON.stringify([sessionId, epoch])))).toString("base64url");
}

/** Start a portable iteration over the captured generation without reading its first page yet. */
export function firstHistoryCursor(sessionId: string, epoch: string, throughSeq: number): string {
	return `${cursorScope(sessionId, epoch)}.1.${throughSeq}`;
}

/** The retained suffix of an append-order task transcript remembers its preceding saved prefix. */
export function earlierTranscriptCursor(sessionId: string, epoch: string, through: number): string {
	return `${cursorScope(sessionId, epoch)}.1.${through}.b.1.${through}`;
}

/** A lazy sequence of pages of the generation and watermark the caller observed. Metadata is sized before any
 * payload read. A new generation is rejected by readRange inside the same snapshot that reads the payload. */
export async function* historyPages(
	store: SessionStore,
	sessionId: string,
	epoch: string | undefined,
	watermark: number,
	options: SessionHistoryReadOptions,
	packet?: HistoryPacketReader,
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
	while (start <= end) {
		options.signal?.throwIfAborted();
		const branchCut =
			leaf === undefined
				? undefined
				: { leaf, first: firstSeq, last: lastSeq, pivot: reverse ? end : start, backward: reverse, epoch: stamp };
		const span = !branchCut
			? undefined
			: store.readBranchSpan
				? await store.readBranchSpan(sessionId, branchCut)
				: await (await import("./snapshot-history.js")).snapshotBranchSpan(store, sessionId, branchCut);
		if (leaf !== undefined) {
			options.signal?.throwIfAborted();
			if (!span) return;
		}
		const left = span?.start ?? start,
			right = span?.end ?? end;
		const from = reverse ? Math.max(left, right - SESSION_HISTORY_PAGE_ENTRIES + 1) : left;
		const through = reverse ? right : Math.min(right, left + SESSION_HISTORY_PAGE_ENTRIES - 1);
		let page: SessionHistoryPage["items"];
		let low: number, high: number;
		if (packet) {
			page = await packet(from, through, reverse);
			options.signal?.throwIfAborted();
			const edge = reverse ? through : from;
			const first = page[0],
				last = page.at(-1);
			if (!first || !last || (reverse ? last.seq : first.seq) !== edge)
				throw new Error(`Missing session history at entry ${edge}`);
			low = first.seq;
			high = last.seq;
		} else if (snapshotOnly) {
			const result = await snapshotPage(store, sessionId, from, through, reverse, cut, stamp);
			options.signal?.throwIfAborted();
			stamp = result.epoch;
			scope = cursorScope(sessionId, stamp);
			if (cursorStamp && scope !== cursorStamp)
				throw new TypeError("History cursor does not match this session generation");
			page = result.items;
			low = page[0]!.seq;
			high = page[page.length - 1]!.seq;
		} else {
			const sized = await store.readEntrySizes!(sessionId, from, through);
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
			if (referenceMetadataRead(options)) {
				low = from;
				high = through;
				// Internal raw-reference verification takes byte locators, not decoded conversation payloads.
				page = sized.sizes.map((s) => ({
					kind: "oversized" as const,
					seq: s.seq,
					bytes: s.bytes,
					epoch: stamp!,
					sessionId,
				}));
			} else if (first.bytes > SESSION_HISTORY_PAGE_BYTES) {
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
		const requestedStart = start,
			requestedEnd = end;
		if (reverse) end = low - 1;
		else start = high + 1;
		const hasOlder = span ? low > left || span.older : low > firstSeq;
		const hasNewer = span ? high < right || span.newer : high < lastSeq;
		const hasNext = reverse ? hasOlder : hasNewer;
		const cursorFor = (from: number, to: number, backward: boolean) =>
			`${scope}.${from}.${to}${backward ? ".b" : ""}${options.adjacent || leaf !== undefined ? `.${firstSeq}.${lastSeq}` : ""}${leaf === undefined ? "" : `.p${leaf}`}${snapshotOnly ? `.s${cut}` : ""}`;
		observeReferenceCut(options, store, sessionId, stamp, cut);
		yield {
			items: page,
			...(hasNext ? { nextCursor: cursorFor(start, end, reverse) } : {}),
			...(options.adjacent
				? {
						adjacent: {
							current: cursorFor(requestedStart, requestedEnd, reverse),
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
	options.signal?.throwIfAborted();
	const snapshot = historySnapshotFor(store);
	// Branch spans may need a separate index snapshot. Never request one from inside a single-connection reader.
	if (
		snapshot &&
		!referenceMetadataRead(options) &&
		options.branchLeafSeq === undefined &&
		!options.cursor?.includes(".p")
	) {
		let request = options;
		for (;;) {
			options.signal?.throwIfAborted();
			const page = await snapshot(sessionId, async (epoch, lastSeq, packet) => {
				const reader = historyPages(store, sessionId, epoch, lastSeq, request, packet);
				try {
					const result = await reader.next();
					return result.done ? undefined : result.value;
				} finally {
					await reader.return();
				}
			});
			options.signal?.throwIfAborted();
			if (!page) return;
			yield page;
			if (!page.nextCursor) return;
			request = { cursor: page.nextCursor, signal: options.signal, adjacent: options.adjacent };
			await yieldToEventLoop();
		}
	}
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
	store: SessionStore,
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
				: await snapshotChunk(store, reference, offset);
		options.signal?.throwIfAborted();
		if (!data.length || data.length > SESSION_HISTORY_CHUNK_BYTES || offset + data.length > reference.bytes)
			throw new Error(`Incomplete or invalid historical entry ${reference.seq}`);
		offset += data.length;
		yield data;
		if (offset < reference.bytes) await yieldToEventLoop();
	}
}
