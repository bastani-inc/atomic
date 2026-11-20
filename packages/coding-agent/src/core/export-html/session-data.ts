import type { SessionManager } from "../session-manager.ts";
import { chunkedForkLink } from "../storage/session/chunked-resume-projection.js";
import { SessionConflictError, SessionNotFoundError } from "../storage/session/errors.js";
import { historyChunks, historyPages, readAhead, selectedHistoryPages } from "../storage/session/history-pages.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionToolUseSelection,
} from "../storage/session/types.js";
import type { renderHtmlInputs } from "./render-inputs.js";

/** A manager can move to another session while the file is being written. Capture the physical store,
 * durable header/generation/watermark and the selected leaf before building either pass. */
export async function captureHtmlHistory(sm: SessionManager) {
	const store = sm.getSessionStore();
	const id = sm.getSessionId();
	const leafId = sm.getLeafId();
	const cut =
		store.readEntrySizes && store.readRange
			? await store.readEntrySizes(id, 1, 0)
			: await (await import("../storage/session/snapshot-history.js")).snapshotHead(store, id);
	const header =
		"header" in cut
			? (cut.header as import("../storage/session/types.js").SessionRecordHeader)
			: await store.readHeader(id);
	if (!header) throw new SessionNotFoundError(id);
	if (!("header" in cut) && store.readScanPage) {
		// One read that rejects another generation: the header is the cut's.
		const confirmed = await store.readScanPage(id, 1, 0, cut.epoch, 1);
		if (confirmed.lastSeq < cut.lastSeq) throw new SessionConflictError(id, cut.lastSeq, confirmed.lastSeq);
	} else if (!("header" in cut) && store.readEntrySizes) {
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
				select && store.readScanPage && cut.epoch !== undefined
					? selectedHistoryPages(
							store as Required<Pick<typeof store, "readScanPage">>,
							id,
							cut.epoch,
							cut.lastSeq,
							select,
						)
					: historyPages(store, id, cut.epoch, cut.lastSeq, { pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
			),
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
		readHistoryChunks: (item: OversizedSessionEntry, offset = 0) =>
			historyChunks(store, id, cut.epoch, item, { offset, bytes: SESSION_HISTORY_PAGE_BYTES }),
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
