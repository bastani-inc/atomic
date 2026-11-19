import { readSessionHistoryChunks } from "./history-pages.js";
import type { SessionForkRow, SessionStore } from "./types.js";

interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly value: Uint8Array;
}

/** Locate top-level structural links in an existing v4 JSON object without packing JSON tokens. A
 * quoted brace, an escaped key or a field of an object inside a tool result is not a top-level link. */
async function fields(
	chunks: AsyncIterable<Uint8Array>,
	overrides: NonNullable<SessionForkRow["edits"]>,
): Promise<Replacement[]> {
	const changes: Replacement[] = [];
	let depth = 0,
		quoted = false,
		escaped = false,
		keyExpected = false,
		keyReading = false,
		offset = 0;
	let pending: string | undefined,
		valueStart: number | undefined,
		keyBytes: number[] = [];
	const seen = new Set<string>();
	for await (const chunk of chunks) {
		for (const b of chunk) {
			if (quoted) {
				if (keyReading && keyBytes.length < 128) keyBytes.push(b);
				if (escaped) escaped = false;
				else if (b === 92) escaped = true;
				else if (b === 34) {
					quoted = false;
					if (keyReading) {
						keyReading = false;
						keyExpected = false;
						if (keyBytes.length < 128) {
							const key = JSON.parse(Buffer.from(keyBytes).toString("utf8"));
							if (Object.hasOwn(overrides, key)) pending = key;
						}
					}
				}
			} else {
				if (
					depth === 1 &&
					pending !== undefined &&
					valueStart === undefined &&
					b !== 58 &&
					b !== 32 &&
					b !== 9 &&
					b !== 10 &&
					b !== 13
				)
					valueStart = offset;
				if (depth === 1 && (b === 44 || b === 125)) {
					if (pending !== undefined && valueStart !== undefined) {
						changes.push({
							start: valueStart,
							end: offset,
							value: Buffer.from(JSON.stringify(overrides[pending])),
						});
						seen.add(pending);
					}
					pending = undefined;
					valueStart = undefined;
					keyExpected = b === 44;
					if (b === 125) {
						const tail = Object.entries(overrides)
							.filter(([k]) => !seen.has(k))
							.map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
							.join("");
						if (tail) changes.push({ start: offset, end: offset, value: Buffer.from(tail) });
					}
				}
				if (b === 34) {
					quoted = true;
					keyReading = depth === 1 && keyExpected;
					if (keyReading) keyBytes = [b];
				} else if (b === 123 || b === 91) {
					depth++;
					if (depth === 1) keyExpected = true;
				} else if (b === 125 || b === 93) depth--;
			}
			offset++;
		}
	}
	return changes;
}

/** The unmodified source entry, or just its structural link substitutions. Size is known before
 * allocating the memory store's owned backing. The iterator owns at most one source chunk. */
export async function encodedForkRow(
	reader: SessionStore,
	row: SessionForkRow,
): Promise<{ size: number; chunks(): AsyncIterable<Uint8Array> }> {
	const ref = row.reference;
	if (!ref) {
		const bytes = Buffer.from(JSON.stringify(row.entry));
		return {
			size: bytes.length,
			async *chunks() {
				yield bytes;
			},
		};
	}
	const read = () => readSessionHistoryChunks(reader, ref);
	const changes = row.edits ? await fields(read(), row.edits) : [];
	return {
		size: ref.bytes + changes.reduce((n, r) => n + r.value.length - (r.end - r.start), 0),
		async *chunks() {
			if (!changes.length) {
				yield* read();
				return;
			}
			let i = 0,
				offset = 0;
			for await (const part of read()) {
				const end = offset + part.length;
				let start = offset;
				while (i < changes.length) {
					const edit = changes[i]!;
					if (edit.start >= end) break;
					if (edit.start >= start) {
						if (edit.start > start) yield part.subarray(start - offset, edit.start - offset);
						yield edit.value;
					}
					start = Math.max(start, edit.end);
					if (edit.end > end) break;
					i++;
				}
				if (start < end) yield part.subarray(start - offset);
				offset = end;
			}
		},
	};
}
