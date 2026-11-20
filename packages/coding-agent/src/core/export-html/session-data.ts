import type { SessionManager } from "../session-manager.ts";
import { chunkedForkLink } from "../storage/session/chunked-resume-projection.js";
import { SessionConflictError, SessionNotFoundError } from "../storage/session/errors.js";
import { historyChunks, historyPages, readAhead, selectedHistoryPages } from "../storage/session/history-pages.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionToolUseSelection,
} from "../storage/session/types.js";
import type { renderHtmlInputs } from "./render-inputs.js";

/**
 * An entry larger than a page but at most this large is read whole, once, by the renderer inputs pass, which tokenizes
 * it from memory as often as it needs (#5571). A larger one is streamed from the store for each reading.
 */
export const OVERSIZED_WHOLE_BYTES = 8 * 1024 * 1024;

/**
 * The bytes of such entries the renderer inputs pass read that the data pass reads from memory, at most this many at
 * once; each is released once the data pass wrote it (#5571).
 */
export const OVERSIZED_KEPT_BYTES = 8 * 1024 * 1024;

/** `bytes` from `offset`, in reads no larger than a store's default chunk. */
export async function* sliced(bytes: Buffer, offset: number): AsyncGenerator<Uint8Array, void> {
	for (let at = offset; at < bytes.length; at += SESSION_HISTORY_CHUNK_BYTES)
		yield bytes.subarray(at, at + SESSION_HISTORY_CHUNK_BYTES);
}

/** A manager can move to another session while the file is being written. Capture the physical store,
 * durable header/generation/watermark and the selected leaf before building either pass. */
export async function captureHtmlHistory(sm: SessionManager) {
	const store = sm.getSessionStore();
	const id = sm.getSessionId();
	const leafId = sm.getLeafId();
	// A store that reads a scan's pages reads the header, generation and watermark in one statement too.
	const cut = store.readScanPage
		? await store.readScanPage(id, 1, 0, undefined, 1)
		: store.readEntrySizes && store.readRange
			? await store.readEntrySizes(id, 1, 0)
			: await (await import("../storage/session/snapshot-history.js")).snapshotHead(store, id);
	const header =
		"header" in cut
			? (cut.header as import("../storage/session/types.js").SessionRecordHeader)
			: await store.readHeader(id);
	if (!header) throw new SessionNotFoundError(id);
	const kept = new Map<number, Buffer>();
	let keptBytes = 0;
	// The first bytes of oversized entries the pages read ahead brought, until the pass asks for them.
	const prefixes = new Map<number, Uint8Array>();
	async function* withPrefixes<T extends { readonly prefixes?: ReadonlyMap<number, Uint8Array> }>(
		pages: AsyncGenerator<T, void>,
	): AsyncGenerator<T, void> {
		for await (const page of pages) {
			for (const [seq, prefix] of page.prefixes ?? []) prefixes.set(seq, prefix);
			yield page;
		}
	}
	if (!("header" in cut) && store.readEntrySizes) {
		const confirmed = await store.readEntrySizes(id, 1, 0);
		if (cut.epoch !== confirmed.epoch || confirmed.lastSeq < cut.lastSeq)
			throw new SessionConflictError(id, cut.lastSeq, confirmed.lastSeq);
	}
	return {
		header: { type: "session" as const, ...header },
		leafId,
		// Every pass reads the whole cut at once, so it reads as a scan: more entries a page, never more bytes. One
		// store read every 64 entries made a long session's export several times slower than main's full load (#5571).
		// Each page is read while the one before it is rendered or written, so a database server's round trips overlap
		// that work; at most two pages are held. A pass that needs only tool calls and results reads only the entries
		// that can hold them, from a store that can select them (#5571).
		readHistory: (select?: SessionToolUseSelection) =>
			readAhead(
				store.readScanPage && cut.epoch !== undefined
					? withPrefixes(
							selectedHistoryPages(
								store as Required<Pick<typeof store, "readScanPage">>,
								id,
								cut.epoch,
								cut.lastSeq,
								{
									trailingReference: true,
									...(select ? { select, referencePrefix: SESSION_HISTORY_CHUNK_BYTES } : {}),
								},
							),
						)
					: historyPages(store, id, cut.epoch, cut.lastSeq, { pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
			),
		/** The first bytes of an oversized entry its page brought, once. */
		prefixOf(item: OversizedSessionEntry) {
			const prefix = prefixes.get(item.seq);
			prefixes.delete(item.seq);
			return prefix;
		},
		/** Resolve an edge on another branch without an export-wide map of removed links. */
		async visibleParent(parent: string | null, before: number) {
			if (parent === null) return null;
			for await (const { items } of historyPages(store, id, cut.epoch, cut.lastSeq, {
				direction: "backward",
				toSeq: before,
			})) {
				for (let i = items.length - 1; i >= 0; i--) {
					const item = items[i]!;
					const link =
						"entry" in item
							? {
									id: item.entry.id,
									parentId: item.entry.parentId,
									anchor: item.entry.type === "custom" && item.entry.customType === "atomic.fork-anchor",
								}
							: await chunkedForkLink(() => historyChunks(store, id, cut.epoch, item, {}));
					if (link.id !== parent) continue;
					if (!link.anchor) return parent;
					parent = link.parentId ?? null;
					if (parent === null) return null;
				}
			}
			return parent;
		},
		// An entry larger than a page is read a page's bytes at a time: its passes stream it whole, often more than once.
		readHistoryChunks: (item: OversizedSessionEntry, offset = 0, bytes = SESSION_HISTORY_PAGE_BYTES) => {
			const held = kept.get(item.seq);
			return held ? sliced(held, offset) : historyChunks(store, id, cut.epoch, item, { offset, bytes });
		},
		/**
		 * An oversized entry's exact bytes, from memory when the renderer inputs pass kept them, otherwise read after the
		 * `prefix` already read, and kept for the data pass while all kept entries fit OVERSIZED_KEPT_BYTES.
		 */
		async readWhole(item: OversizedSessionEntry, prefix: Uint8Array = new Uint8Array()) {
			const held = kept.get(item.seq);
			if (held) return held;
			const bytes = Buffer.allocUnsafe(item.bytes);
			let at = Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength).copy(bytes);
			for await (const chunk of historyChunks(store, id, cut.epoch, item, {
				offset: at,
				bytes: SESSION_HISTORY_PAGE_BYTES,
			}))
				at += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(bytes, at);
			if (at !== item.bytes) throw new Error(`Incomplete historical entry ${item.seq}`);
			if (keptBytes + bytes.length <= OVERSIZED_KEPT_BYTES) {
				kept.set(item.seq, bytes);
				keptBytes += bytes.length;
			}
			return bytes;
		},
		/** The data pass wrote the entry: its kept bytes are not read again. */
		release(item: OversizedSessionEntry) {
			const held = kept.get(item.seq);
			if (!held) return;
			kept.delete(item.seq);
			keptBytes -= held.length;
		},
	};
}

/** A single output JSON object. Entries can be larger than any page: copy their exact UTF-8 bytes directly to
 * the encoder. Only fields exposed to an extension's renderer are replaced, without decoding the rest. */
export async function* sessionDataBytes(
	source: Awaited<ReturnType<typeof captureHtmlHistory>>,
	metadataJson: string,
	inputs: Awaited<ReturnType<typeof renderHtmlInputs>> | undefined,
): AsyncGenerator<Uint8Array, void> {
	yield Buffer.from(`{"header":${JSON.stringify(source.header)},"entries":[`);
	let first = true,
		sawAnchor = false;
	let lastId: string | null = null,
		lastVisible: string | null = null;
	let leaf = source.leafId;
	for await (const { items } of source.readHistory()) {
		let ordinary = "";
		for (const item of items) {
			const row = "entry" in item ? (inputs?.entry(item.seq, item.entry) ?? item.entry) : undefined;
			const link = row
				? {
						id: row.id,
						parentId: row.parentId,
						anchor: row.type === "custom" && row.customType === "atomic.fork-anchor",
					}
				: !("entry" in item) && (sawAnchor || source.header.parentSessionId !== undefined)
					? await chunkedForkLink(() => source.readHistoryChunks(item))
					: undefined;
			const parent: string | null = link
				? !sawAnchor
					? (link.parentId ?? null)
					: link.parentId === lastId
						? lastVisible
						: await source.visibleParent(link.parentId ?? null, item.seq - 1)
				: null;
			lastId = link?.id ?? null;
			if (link?.anchor) {
				sawAnchor = true;
				lastVisible = parent;
				if (leaf === link.id) leaf = parent;
				continue;
			}
			lastVisible = lastId;
			const separator = first ? "" : ",";
			first = false;
			if (row) ordinary += separator + JSON.stringify(row.parentId === parent ? row : { ...row, parentId: parent });
			else if (!("entry" in item)) {
				if (ordinary || separator) yield Buffer.from(ordinary + separator);
				ordinary = "";
				const patches = inputs?.oversizedPatches(item.seq);
				const bytes = source.readHistoryChunks(item);
				const rendered = patches?.length ? (await import("./json-spans.js")).patchJson(bytes, patches) : bytes;
				yield* link && parent !== link.parentId ? rewriteObjectParent(rendered, parent) : rendered;
				source.release(item);
			}
		}
		if (ordinary) yield Buffer.from(ordinary);
	}
	if (leaf !== source.leafId) metadataJson = JSON.stringify({ ...JSON.parse(metadataJson), leafId: leaf });
	yield Buffer.from(`],${metadataJson.slice(1, -1)}`);
	if (inputs?.rendered.size) {
		yield Buffer.from(',"renderedTools":{');
		let first = true;
		for (const [id, rendered] of inputs.rendered) {
			yield Buffer.from(`${first ? "" : ","}${JSON.stringify(id)}:${JSON.stringify(rendered)}`);
			first = false;
		}
		yield Buffer.from("}");
	}
	yield Buffer.from("}");
}

/** At the closing brace, override only the top-level parent of the embedded JSON object. The
 * original object can exceed the JS string limit; do not concatenate or decode it. */
async function* rewriteObjectParent(parts: AsyncIterable<Uint8Array>, parent: string | null) {
	let depth = 0,
		quoted = false,
		escaped = false;
	for await (const bytes of parts) {
		let start = 0;
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i];
			if (quoted) {
				if (escaped) escaped = false;
				else if (b === 92) escaped = true;
				else if (b === 34) quoted = false;
				continue;
			}
			if (b === 34) quoted = true;
			else if (b === 123 || b === 91) depth++;
			else if (b === 125 || b === 93) {
				depth--;
				if (depth === 0 && b === 125) {
					yield bytes.subarray(start, i);
					yield Buffer.from(`,"parentId":${JSON.stringify(parent)}`);
					start = i;
				}
			}
		}
		yield bytes.subarray(start);
	}
}

/** Base64 padding belongs only at EOF, not at page, entry or UTF-8 boundaries. */
export async function* encodeSessionData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string, void> {
	let carry = Buffer.alloc(0);
	for await (const chunk of chunks) {
		const data = carry.length
			? Buffer.concat([carry, chunk])
			: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const through = data.length - (data.length % 3);
		if (through) yield data.toString("base64", 0, through);
		carry = Buffer.from(data.subarray(through));
	}
	if (carry.length) yield carry.toString("base64");
}
