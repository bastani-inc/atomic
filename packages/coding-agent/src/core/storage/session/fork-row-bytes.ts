import { readSessionHistoryChunks } from "./history-pages.js";
import type { SessionForkRow, SessionStore } from "./types.js";

type Links = NonNullable<SessionForkRow["edits"]>;

/** The code unit of each single-character JSON escape, by the byte after the backslash. */
const ESCAPED: Readonly<Record<number, number>> = { 34: 34, 47: 47, 92: 92, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };

function hexDigit(b: number): number {
	if (b >= 48 && b <= 57) return b - 48;
	const lower = b | 32;
	return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/** Compare a top-level key with the link names as its bytes arrive. Escapes and UTF-8 decode to the
 * UTF-16 code units JSON.parse would give; the state does not grow with the key or its reads. */
function keyMatcher(names: readonly string[]) {
	const alive = names.map(() => false);
	let live = 0,
		units = 0,
		backslash = false,
		hex = 0,
		continuation = 0,
		code = 0,
		least = 0;
	const unit = (u: number) => {
		for (let k = 0; k < names.length; k++)
			if (alive[k] && names[k]!.charCodeAt(units) !== u) {
				alive[k] = false;
				live--;
			}
		units++;
	};
	return {
		start() {
			alive.fill(true);
			live = names.length;
			units = hex = continuation = 0;
			backslash = false;
		},
		/** A byte between the quotes. */
		byte(b: number) {
			if (!live) return;
			if (hex) {
				const digit = hexDigit(b);
				if (digit < 0) live = 0;
				else {
					code = code * 16 + digit;
					if (!--hex) unit(code);
				}
			} else if (backslash) {
				backslash = false;
				const escapedUnit = ESCAPED[b];
				if (b === 117) {
					hex = 4;
					code = 0;
				} else if (escapedUnit === undefined) live = 0;
				else unit(escapedUnit);
			} else if (continuation) {
				if ((b & 0xc0) !== 0x80) {
					live = 0;
					return;
				}
				code = (code << 6) | (b & 0x3f);
				if (--continuation) return;
				if (code < least || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) live = 0;
				else if (code < 0x10000) unit(code);
				else {
					unit(0xd800 + ((code - 0x10000) >> 10));
					unit(0xdc00 + ((code - 0x10000) & 0x3ff));
				}
			} else if (b === 92) backslash = true;
			else if (b < 0x80) unit(b);
			else if (b >= 0xc2 && b <= 0xf4) {
				continuation = b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
				code = b & (0x3f >> continuation);
				least = continuation === 1 ? 0x80 : continuation === 2 ? 0x800 : 0x10000;
			} else live = 0;
		},
		/** The index of the link the closed key names, or -1. */
		end(): number {
			if (!live || backslash || hex || continuation) return -1;
			return alive.findIndex((on, k) => on && names[k]!.length === units);
		},
	};
}

/** Replace the values of top-level link fields of an existing v4 JSON object, and append the links it
 * lacks before its closing brace, without packing JSON tokens. A quoted brace, a key-like string or a
 * field of an object inside a tool result is not a top-level link; duplicated link keys are all
 * replaced. Every other byte is copied unchanged, and the scan state is constant whatever the number
 * of fields, keys or reads, so a non-canonical row cannot grow it. */
function linkRewrite(links: Links) {
	const names = Object.keys(links);
	const values = names.map((k) => Buffer.from(JSON.stringify(links[k])));
	const appended = names.map((k) => Buffer.from(`,${JSON.stringify(k)}:${JSON.stringify(links[k])}`));
	const seen = names.map(() => false);
	const key = keyMatcher(names);
	let depth = 0,
		quoted = false,
		escaped = false,
		keyExpected = false,
		keyReading = false,
		pending = -1,
		valueStarted = false;
	/** The output for the next read of the source. */
	return function* parts(chunk: Uint8Array): Generator<Uint8Array, void> {
		// The start of the unwritten copied bytes of this read, or -1 inside a replaced value.
		let from = pending >= 0 && valueStarted ? -1 : 0;
		for (let i = 0; i < chunk.length; i++) {
			if (quoted && !keyReading) {
				// Only the closing quote changes the state inside a string that is not a top-level key.
				if (escaped) {
					escaped = false;
					i++;
				}
				while (i < chunk.length && chunk[i] !== 34) i += chunk[i] === 92 ? 2 : 1;
				if (i >= chunk.length) {
					escaped = i > chunk.length;
					break;
				}
			}
			const b = chunk[i]!;
			if (quoted) {
				if (escaped || b !== 34) {
					if (keyReading) key.byte(b);
					escaped = !escaped && b === 92;
					continue;
				}
				quoted = false;
				if (keyReading) {
					keyReading = keyExpected = false;
					const k = key.end();
					if (k >= 0) pending = k;
				}
				continue;
			}
			if (depth === 1) {
				if (pending >= 0 && !valueStarted && b !== 58 && b !== 32 && b !== 9 && b !== 10 && b !== 13) {
					valueStarted = true;
					if (i > from) yield chunk.subarray(from, i);
					from = -1;
					yield values[pending]!;
				}
				if (b === 44 || b === 125) {
					if (pending >= 0) {
						seen[pending] = true;
						from = i;
					}
					pending = -1;
					valueStarted = false;
					keyExpected = b === 44;
					if (b === 125 && seen.includes(false)) {
						if (i > from) yield chunk.subarray(from, i);
						from = i;
						for (let k = 0; k < names.length; k++) if (!seen[k]) yield appended[k]!;
					}
				}
			}
			if (b === 34) {
				quoted = true;
				keyReading = depth === 1 && keyExpected;
				if (keyReading) key.start();
			} else if (b === 123 || b === 91) {
				if (++depth === 1) keyExpected = true;
			} else if (b === 125 || b === 93) depth--;
		}
		if (from >= 0 && from < chunk.length) yield from ? chunk.subarray(from) : chunk;
	};
}

/** The unmodified source entry, or just its structural link substitutions. Size is known before
 * allocating the memory store's owned backing: the first read measures the rewrite and the second
 * streams it. The iterator owns at most one source chunk. */
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
	const links = row.edits;
	if (!links) return { size: ref.bytes, chunks: read };
	let size = 0;
	const measure = linkRewrite(links);
	for await (const chunk of read()) for (const part of measure(chunk)) size += part.length;
	return {
		size,
		async *chunks() {
			const parts = linkRewrite(links);
			for await (const chunk of read()) yield* parts(chunk);
		},
	};
}
