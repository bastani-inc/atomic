// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 */

import type { Cursor } from "./types.js";

/** File-section header delimiters: `[path#hash]`. */
export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";

/** Payload sigil for literal body rows. */
export const HL_PAYLOAD_REPLACE = "+";

/** Hunk-header keyword for concrete line replacement. */
export const HL_REPLACE_KEYWORD = "replace";
/** Hunk-header sub-keyword: `replace block N:` resolves N to a tree-sitter block range. */
export const HL_BLOCK_KEYWORD = "block";
/** Hunk-header keyword for concrete line deletion. */
export const HL_DELETE_KEYWORD = "delete";
/** Hunk-header keyword for insertion operations. */
export const HL_INSERT_KEYWORD = "insert";
/** Insert position keyword for inserting before a concrete line. */
export const HL_INSERT_BEFORE = "before";
/** Insert position keyword for inserting after a concrete line. */
export const HL_INSERT_AFTER = "after";
/** Insert position keyword for inserting at the start of the file. */
export const HL_INSERT_HEAD = "head";
/** Insert position keyword for inserting at the end of the file. */
export const HL_INSERT_TAIL = "tail";
/** Hunk-header terminator for body-bearing operations. */
export const HL_HEADER_COLON = ":";

/** Separator between a hashline file path and its opaque snapshot tag. */
export const HL_FILE_HASH_SEP = "#";

/** Separator between two line numbers in a range, e.g. `5..10`. */
export const HL_RANGE_SEP = "..";

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":";

function regexEscape(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export const HL_LINE_RE_RAW = `[1-9]\\d*`;

/** Capture-group form of {@link HL_LINE_RE_RAW}. */
export const HL_LINE_CAPTURE_RE_RAW = `(${HL_LINE_RE_RAW})`;

/** Format a concrete replacement hunk header. */
export function formatReplaceHeader(start: number, end: number): string {
	return `${HL_REPLACE_KEYWORD} ${start}${HL_RANGE_SEP}${end}${HL_HEADER_COLON}`;
}

/** Format a concrete deletion hunk header. */
export function formatDeleteHeader(start: number, end = start): string {
	return start === end ? `${HL_DELETE_KEYWORD} ${start}` : `${HL_DELETE_KEYWORD} ${start}${HL_RANGE_SEP}${end}`;
}

/** Format an insertion hunk header for a cursor position. */
export function formatInsertHeader(cursor: Cursor): string {
	switch (cursor.kind) {
		case "before_anchor":
			return `${HL_INSERT_KEYWORD} ${HL_INSERT_BEFORE} ${cursor.anchor.line}${HL_HEADER_COLON}`;
		case "after_anchor":
			return `${HL_INSERT_KEYWORD} ${HL_INSERT_AFTER} ${cursor.anchor.line}${HL_HEADER_COLON}`;
		case "bof":
			return `${HL_INSERT_KEYWORD} ${HL_INSERT_HEAD}${HL_HEADER_COLON}`;
		case "eof":
			return `${HL_INSERT_KEYWORD} ${HL_INSERT_TAIL}${HL_HEADER_COLON}`;
	}
}

/** Number of hex characters in a content-derived file-hash tag. */
export const HL_FILE_HASH_LENGTH = 4;
/** Canonical uppercase hexadecimal content-hash tag carried by a hashline section header. */
export const HL_FILE_HASH_RE_RAW = `[0-9A-F]{${HL_FILE_HASH_LENGTH}}`;
/** Capture-group form of {@link HL_FILE_HASH_RE_RAW}. */
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`;
/** Regex-escaped form of {@link HL_LINE_BODY_SEP}, safe for embedding inside a regex. */
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP);
/**
 * Representative file-hash tags for use in user-facing error messages and
 * prompt examples.
 */
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const;
/**
 * Normalize text before hashing: trim trailing `[ \t\r]` from every line (and
 * the final line) in a single pass so CRLF endings and display-trimmed lines
 * do not invalidate a tag.
 */
function normalizeFileHashText(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}
/**
 * Compute the content-derived hash tag carried by a hashline section header.
 * The tag is a 4-hex fingerprint of the whole file's normalized text: any read
 * of byte-identical content mints the same tag, and a follow-up edit anchored
 * at any line validates whenever the live file still hashes to it.
 */
// xxHash32 (canonical, seed 0) to match upstream Bun.hash.xxHash32 so section tags
// are byte-identical to oh-my-pi for identical content. Pure-JS for Node runtime.
const XXH_PRIME32_1 = 0x9e3779b1;
const XXH_PRIME32_2 = 0x85ebca77;
const XXH_PRIME32_3 = 0xc2b2ae3d;
const XXH_PRIME32_4 = 0x27d4eb2f;
const XXH_PRIME32_5 = 0x165667b1;
function xxhRotl(value: number, bits: number): number {
	return (value << bits) | (value >>> (32 - bits));
}
function xxhRound(acc: number, input: number): number {
	acc = (acc + Math.imul(input, XXH_PRIME32_2)) | 0;
	acc = xxhRotl(acc, 13);
	return Math.imul(acc, XXH_PRIME32_1) | 0;
}
function xxHash32(bytes: Uint8Array): number {
	const len = bytes.length;
	let index = 0;
	let h32: number;
	const readU32 = (offset: number): number =>
		(bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
	if (len >= 16) {
		let v1 = (XXH_PRIME32_1 + XXH_PRIME32_2) | 0;
		let v2 = XXH_PRIME32_2 | 0;
		let v3 = 0;
		let v4 = -XXH_PRIME32_1 | 0;
		const limit = len - 16;
		while (index <= limit) {
			v1 = xxhRound(v1, readU32(index)); index += 4;
			v2 = xxhRound(v2, readU32(index)); index += 4;
			v3 = xxhRound(v3, readU32(index)); index += 4;
			v4 = xxhRound(v4, readU32(index)); index += 4;
		}
		h32 = (xxhRotl(v1, 1) + xxhRotl(v2, 7) + xxhRotl(v3, 12) + xxhRotl(v4, 18)) | 0;
	} else {
		h32 = XXH_PRIME32_5 | 0;
	}
	h32 = (h32 + len) | 0;
	while (index + 4 <= len) {
		h32 = (h32 + Math.imul(readU32(index), XXH_PRIME32_3)) | 0;
		h32 = Math.imul(xxhRotl(h32, 17), XXH_PRIME32_4) | 0;
		index += 4;
	}
	while (index < len) {
		h32 = (h32 + Math.imul(bytes[index]!, XXH_PRIME32_5)) | 0;
		h32 = Math.imul(xxhRotl(h32, 11), XXH_PRIME32_1) | 0;
		index += 1;
	}
	h32 ^= h32 >>> 15;
	h32 = Math.imul(h32, XXH_PRIME32_2);
	h32 ^= h32 >>> 13;
	h32 = Math.imul(h32, XXH_PRIME32_3);
	h32 ^= h32 >>> 16;
	return h32 >>> 0;
}
const xxhEncoder = new TextEncoder();
export function computeFileHash(text: string): string {
	const normalized = normalizeFileHashText(text);
	const low16 = xxHash32(xxhEncoder.encode(normalized)) & 0xffff;
	return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();
}

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160", "42", "7"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"];
	return examples.map(e => `"${e}"`).join(", ");
}

/** Format a hashline section header for a file path and snapshot tag. */
export function formatHashlineHeader(filePath: string, fileHash: string): string {
	return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}

/** Formats a single numbered line as `LINE:TEXT`. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/** Format file text with hashline-mode line-number prefixes for display. */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n");
}
