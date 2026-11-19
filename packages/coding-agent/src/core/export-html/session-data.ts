import type { SessionManager } from "../session-manager.js";
import { chunkedForkLink } from "../storage/session/chunked-resume-projection.js";
import { SessionConflictError, SessionNotFoundError } from "../storage/session/errors.js";
import { historyChunks, historyPages } from "../storage/session/history-pages.js";
import type { OversizedSessionEntry } from "../storage/session/types.js";
import type { renderHtmlInputs } from "./render-inputs.js";

/** A manager can move to another session while the file is being written. Capture the physical store,
 * durable header/generation/watermark and the selected leaf before building either pass. */
export async function captureHtmlHistory(sm: SessionManager) {
	const store = sm.getSessionStore();
	const id = sm.getSessionId();
	const leafId = sm.getLeafId();
	if (!store.readEntrySizes)
		throw new TypeError(`Session store ${store.descriptor.adapter} must implement readEntrySizes for HTML export`);
	const cut = await store.readEntrySizes(id, 1, 0);
	const header = await store.readHeader(id);
	if (!header) throw new SessionNotFoundError(id);
	const confirmed = await store.readEntrySizes(id, 1, 0);
	if (cut.epoch !== confirmed.epoch || confirmed.lastSeq < cut.lastSeq)
		throw new SessionConflictError(id, cut.lastSeq, confirmed.lastSeq);
	return {
		header: { type: "session" as const, ...header },
		leafId,
		readHistory: () => historyPages(store, id, cut.epoch, cut.lastSeq, {}),
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
		readHistoryChunks: (item: OversizedSessionEntry) => historyChunks(store, id, cut.epoch, item, {}),
	};
}

/** A single output JSON object. Entries can be larger than any page: copy their exact UTF-8 bytes directly to
 * the encoder rather than decoding the historical message or passing it through an extension's renderer. */
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
				if (link && parent !== link.parentId) yield* rewriteObjectParent(source.readHistoryChunks(item), parent);
				else yield* source.readHistoryChunks(item);
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
