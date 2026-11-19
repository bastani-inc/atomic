import {
	decodeKittyPrintable,
	Key,
	type KeyId,
	matchesKey as piMatchesKey,
	truncateToWidth as piTruncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";

export { Key, visibleWidth };

const ANSI_ESCAPE_RE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/;
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/;
const SHIFT_MODIFIER = 1;
const LOCK_MODIFIER_MASK = 64 + 128;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (s) => s.segment);
}

export interface GraphemeSegment {
	segment: string;
	index: number;
}

export function graphemeSegments(text: string): GraphemeSegment[] {
	return Array.from(segmenter.segment(text), (s) => ({ segment: s.segment, index: s.index }));
}

function readAnsiCode(text: string, offset: number): string | null {
	const match = ANSI_ESCAPE_RE.exec(text.slice(offset));
	return match?.[0] ?? null;
}

export function truncateToWidth(text: string, width: number, suffix = ""): string {
	if (width > 0 && visibleWidth(text) <= width) return text;
	return piTruncateToWidth(text, width, suffix, false);
}

/** Bounded memo for pure text transforms that repaint identical rows every frame. */
export class BoundedTextCache {
	private readonly entries = new Map<string, string>();
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	get(key: string, compute: () => string): string {
		const cached = this.entries.get(key);
		if (cached !== undefined) return cached;
		const value = compute();
		if (this.entries.size >= this.limit) this.entries.clear();
		this.entries.set(key, value);
		return value;
	}
}

/** Use pi-tui's key parser/matcher with typed key identifiers. */
export function matchesKey(data: string, key: KeyId): boolean {
	return data === key || piMatchesKey(data, key);
}

function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	const match = MODIFY_OTHER_KEYS_RE.exec(data);
	if (!match) return undefined;

	const modifierValue = Number.parseInt(match[1] ?? "", 10);
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	const modifier = Number.isFinite(modifierValue) ? (modifierValue - 1) & ~LOCK_MODIFIER_MASK : 0;

	if ((modifier & ~SHIFT_MODIFIER) !== 0) return undefined;
	if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;

	try {
		return String.fromCodePoint(codepoint);
	} catch {
		return undefined;
	}
}

/** Decode CSI-u / Kitty printable-key sequences emitted by terminals such as VSCode. */
export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}

/**
 * Wrap plain text by terminal cell width while preserving paragraph breaks.
 * Within each paragraph, runs of whitespace collapse to a single space; this
 * keeps labels/descriptions readable but is not intended for preformatted text.
 */
export function wrapPlainText(text: string, width: number): string[] {
	const budget = Math.max(1, Math.floor(width));
	const out: string[] = [];
	for (const paragraph of text.split(/\r?\n/)) {
		const words = paragraph
			.trim()
			.split(/\s+/)
			.filter((word) => word.length > 0);
		if (words.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		let lineWidth = 0;
		for (const word of words) {
			const wordWidth = visibleWidth(word);
			if (wordWidth > budget) {
				if (line.length > 0) {
					out.push(line);
					line = "";
					lineWidth = 0;
				}
				let chunk = "";
				let chunkWidth = 0;
				for (const { segment: g } of segmenter.segment(word)) {
					const gWidth = visibleWidth(g);
					if (chunk.length > 0 && chunkWidth + gWidth > budget) {
						out.push(chunk);
						chunk = g;
						chunkWidth = gWidth;
					} else {
						chunk += g;
						chunkWidth += gWidth;
					}
				}
				line = chunk;
				lineWidth = chunkWidth;
			} else if (line.length === 0) {
				line = word;
				lineWidth = wordWidth;
			} else {
				const candidate = `${line} ${word}`;
				const candidateWidth =
					graphemes(` ${word}`)[0] !== " " || word.includes("\x1b")
						? visibleWidth(candidate)
						: lineWidth + 1 + wordWidth;
				if (candidateWidth <= budget) {
					line = candidate;
					lineWidth = candidateWidth;
				} else {
					out.push(line);
					line = word;
					lineWidth = wordWidth;
				}
			}
		}
		if (line.length > 0) out.push(line);
	}
	return out.length > 0 ? out : [""];
}

export interface WrappedPrefixedLinesOpts {
	text: string;
	width: number;
	plainPrefix: string;
	firstPrefix: string;
	continuationPrefix?: string;
	suffix?: string;
	styleLine?: (line: string, index: number) => string;
}

/**
 * Shared ask-style row wrapper for numbered choices and review value rows.
 * Computes the wrapped text budget from the visible prefix width, then clips
 * the composed ANSI row so narrow terminals never overflow.
 */
export function renderWrappedPrefixedLines(opts: WrappedPrefixedLinesOpts): string[] {
	const continuationPrefix = opts.continuationPrefix ?? " ".repeat(visibleWidth(opts.plainPrefix));
	const textBudget = Math.max(1, opts.width - visibleWidth(opts.plainPrefix));
	return wrapPlainText(opts.text, textBudget).map((line, index) => {
		const prefix = index === 0 ? opts.firstPrefix : continuationPrefix;
		const styled = opts.styleLine ? opts.styleLine(line, index) : line;
		return truncateToWidth(prefix + styled, opts.width, opts.suffix ?? "…");
	});
}

export function sliceColumns(line: string, startCol: number, length: number, strict = false): string {
	if (length <= 0) return "";

	const endCol = startCol + length;
	let result = "";
	let currentCol = 0;
	let offset = 0;
	let pendingAnsi = "";

	while (offset < line.length) {
		const ansiCode = readAnsiCode(line, offset);
		if (ansiCode) {
			if (currentCol >= startCol && currentCol < endCol) {
				result += ansiCode;
			} else if (currentCol < startCol) {
				pendingAnsi += ansiCode;
			}
			offset += ansiCode.length;
			continue;
		}

		let textEnd = offset;
		while (textEnd < line.length && !readAnsiCode(line, textEnd)) {
			textEnd++;
		}

		for (const { segment } of segmenter.segment(line.slice(offset, textEnd))) {
			const width = visibleWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + width <= endCol;

			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
			}

			currentCol += width;
			if (currentCol >= endCol) break;
		}

		offset = textEnd;
		if (currentCol >= endCol) break;
	}

	return result;
}
