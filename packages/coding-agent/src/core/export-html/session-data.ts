import type { SessionManager } from "../session-manager.js";
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
	let first = true;
	for await (const { items } of source.readHistory()) {
		let ordinary = "";
		for (const item of items) {
			const separator = first ? "" : ",";
			first = false;
			if ("entry" in item) ordinary += separator + JSON.stringify(inputs?.entry(item.seq, item.entry) ?? item.entry);
			else {
				if (ordinary || separator) yield Buffer.from(ordinary + separator);
				ordinary = "";
				yield* source.readHistoryChunks(item);
			}
		}
		if (ordinary) yield Buffer.from(ordinary);
	}
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
