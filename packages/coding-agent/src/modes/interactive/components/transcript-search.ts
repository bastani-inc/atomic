/**
 * Atomic's transcript search matcher.
 *
 * pi-tui runs the same algorithm for the fullscreen transcript, but keeps it in
 * `alt-screen-search.ts` and does not export it from its index at 0.84.2. pi-tui
 * ships no `exports` map, so a deep import into `dist/alt-screen-search.js`
 * resolves today and would vanish without a compile error in any upstream
 * refactor. Atomic therefore owns this copy: the main transcript keeps pi-tui's,
 * and this one serves surfaces Atomic renders itself — workflow stage chats now,
 * the workflow graph view when that gets its own design pass.
 *
 * The module is pure. It takes rendered lines and a query, and returns column
 * ranges. Nothing here reads a theme, a viewport, or the terminal; the caller
 * supplies the styling and decides which rows are on screen.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** One highlightable run of columns on one row of the searched corpus. */
export interface TranscriptSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

/** One query occurrence, split into per-row segments when it wraps. */
export interface TranscriptSearchMatch {
	segments: TranscriptSearchSegment[];
}

/** Styling for a matched run of text, supplied by the caller. */
export interface TranscriptSearchHighlightStyles {
	/** Applied to every match that is not the selected one. */
	match(text: string): string;
	/** Applied to the selected match. */
	currentMatch(text: string): string;
}

interface SearchCorpus {
	text: string;
	source: (TranscriptSearchSegment | undefined)[];
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface TerminalAnsiToken {
	text: string;
	width: 0;
	ansi: true;
}

interface TerminalTextToken {
	/** Original bytes, including ANSI sequences embedded inside this grapheme. */
	text: string;
	/** The same grapheme with recognized terminal sequences removed. */
	plainText: string;
	width: number;
	ansi: false;
}

type TerminalLineToken = TerminalAnsiToken | TerminalTextToken;

interface ScannedTerminalLine {
	tokens: TerminalLineToken[];
	width: number;
}

function isPiCsiFinal(code: number): boolean {
	return code === 0x6d || code === 0x47 || code === 0x4b || code === 0x48 || code === 0x4a;
}

/**
 * Tokenize using pi-tui's 0.84.2 terminal-sequence semantics, but pre-index
 * terminators so every input code unit is inspected a bounded number of times.
 * Its `extractAnsiCode()` scans the full remaining suffix for each unterminated
 * ESC `[` / ESC `]`; repeated malformed openers therefore become quadratic.
 */
function scanTerminalLine(line: string): ScannedTerminalLine {
	const length = line.length;
	const hasEscape = line.includes("\x1b");
	const nextCsiFinal = hasEscape ? new Int32Array(length + 1) : undefined;
	const nextStringTerminatorEnd = hasEscape ? new Int32Array(length + 1) : undefined;
	if (nextCsiFinal && nextStringTerminatorEnd) {
		nextCsiFinal.fill(-1);
		nextStringTerminatorEnd.fill(-1);
		let csiFinal = -1;
		let stringTerminatorEnd = -1;
		for (let index = length - 1; index >= 0; index -= 1) {
			if (isPiCsiFinal(line.charCodeAt(index))) csiFinal = index;
			nextCsiFinal[index] = csiFinal;
			if (line.charCodeAt(index) === 0x07) stringTerminatorEnd = index + 1;
			else if (line.charCodeAt(index) === 0x1b && line[index + 1] === "\\") stringTerminatorEnd = index + 2;
			nextStringTerminatorEnd[index] = stringTerminatorEnd;
		}
	}

	const ansiLengthAt = (index: number): number => {
		if (!hasEscape || line.charCodeAt(index) !== 0x1b) return 0;
		const next = line[index + 1];
		if (next === "[") {
			const final = nextCsiFinal?.[index + 2] ?? -1;
			return final >= 0 ? final + 1 - index : 0;
		}
		if (next === "]" || next === "_") {
			const end = nextStringTerminatorEnd?.[index + 2] ?? -1;
			return end >= 0 ? end - index : 0;
		}
		return 0;
	};

	const plainChunks: string[] = [];
	const rawStartByPlainIndex = new Int32Array(length);
	const rawEndByPlainIndex = new Int32Array(length);
	let plainLength = 0;
	let index = 0;
	while (index < length) {
		const ansiLength = ansiLengthAt(index);
		if (ansiLength > 0) {
			index += ansiLength;
			continue;
		}
		let textEnd = index + 1;
		while (textEnd < length && ansiLengthAt(textEnd) === 0) textEnd += 1;
		plainChunks.push(line.slice(index, textEnd));
		for (let rawIndex = index; rawIndex < textEnd; rawIndex += 1) {
			rawStartByPlainIndex[plainLength] = rawIndex;
			rawEndByPlainIndex[plainLength] = rawIndex + 1;
			plainLength += 1;
		}
		index = textEnd;
	}

	const tokens: TerminalLineToken[] = [];
	const plainText = plainChunks.join("");
	let width = 0;
	let rawCursor = 0;
	for (const { segment, index: plainStart } of graphemeSegmenter.segment(plainText)) {
		const plainEnd = plainStart + segment.length;
		const rawStart = rawStartByPlainIndex[plainStart] ?? 0;
		const rawEnd = rawEndByPlainIndex[plainEnd - 1] ?? rawStart;
		if (rawStart > rawCursor) {
			tokens.push({ text: line.slice(rawCursor, rawStart), width: 0, ansi: true });
		}
		let segmentWidth: number;
		if (segment === "\t") segmentWidth = 3;
		else {
			const code = segment.length === 1 ? segment.charCodeAt(0) : 0;
			segmentWidth = code >= 0x20 && code <= 0x7e ? 1 : visibleWidth(segment);
		}
		tokens.push({
			text: line.slice(rawStart, rawEnd),
			plainText: segment,
			width: segmentWidth,
			ansi: false,
		});
		width += segmentWidth;
		rawCursor = rawEnd;
	}
	if (rawCursor < length) tokens.push({ text: line.slice(rawCursor), width: 0, ansi: true });
	return { tokens, width };
}

/** Match pi-tui's strict column slicing against one pre-scanned line. */
function sliceScannedLine(line: ScannedTerminalLine, startCol: number, length: number): string {
	if (length <= 0) return "";
	const endCol = startCol + length;
	const result: string[] = [];
	const pendingAnsi: string[] = [];
	let currentCol = 0;
	for (const token of line.tokens) {
		if (token.ansi) {
			if (currentCol >= startCol && currentCol < endCol) result.push(token.text);
			else if (currentCol < startCol) pendingAnsi.push(token.text);
			continue;
		}
		const inRange = currentCol >= startCol && currentCol < endCol;
		const fits = currentCol + token.width <= endCol;
		if (inRange && fits) {
			if (pendingAnsi.length > 0) result.push(pendingAnsi.splice(0).join(""));
			result.push(token.text);
		}
		currentCol += token.width;
		if (currentCol >= endCol) break;
	}
	return result.join("");
}

function appendMappedText(text: string, span: TranscriptSearchSegment | undefined, corpus: SearchCorpus): void {
	corpus.text += text;
	for (let index = 0; index < text.length; index += 1) corpus.source.push(span);
}

/**
 * Flatten rendered rows into one searchable string plus a per-character map
 * back to the row and columns it came from.
 *
 * Runs of whitespace — including a row boundary — collapse to a single space so
 * a phrase stays findable across the soft wraps and the padding a rendered
 * transcript is full of. The separator is emitted lazily, so no match can start
 * or end on padding.
 */
function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	const corpus: SearchCorpus = { text: "", source: [] };
	let pendingSeparator = false;
	for (let row = 0; row < lines.length; row += 1) {
		const line = scanTerminalLine(lines[row] ?? "");
		let column = 0;
		for (const token of line.tokens) {
			if (token.ansi) continue;
			const text = token.plainText;
			if (/^\s+$/u.test(text)) {
				if (corpus.text.length > 0) pendingSeparator = true;
				column += token.width;
				continue;
			}
			if (pendingSeparator) {
				appendMappedText(" ", undefined, corpus);
				pendingSeparator = false;
			}
			appendMappedText(text, { row, startCol: column, endCol: column + token.width }, corpus);
			column += token.width;
		}
		if (corpus.text.length > 0) pendingSeparator = true;
	}
	return corpus;
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every occurrence of `query` in `lines`, in reading order.
 *
 * Matching is literal (the query is escaped, never interpreted as a pattern),
 * case-insensitive, and whitespace-insensitive. An empty or whitespace-only
 * query matches nothing rather than everything.
 */
export function findSearchMatches(lines: readonly string[], query: string): TranscriptSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	if (!normalizedQuery) return [];
	const corpus = buildSearchCorpus(lines);
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: TranscriptSearchMatch[] = [];
	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		const segments: TranscriptSearchSegment[] = [];
		for (let index = start; index < end; index += 1) {
			const span = corpus.source[index];
			if (!span) continue;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && span.startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, span.endCol);
			} else {
				segments.push({ ...span });
			}
		}
		if (segments.length > 0) matches.push({ segments });
	}
	return matches;
}

/**
 * Identity of a match across re-matching, as first-row/first-column through
 * last-row/last-column. The selected match is followed by this key rather than
 * by index, so rows appended above or below it do not move the selection.
 */
export function getSearchMatchKey(match: TranscriptSearchMatch): string {
	const first = match.segments[0];
	const last = match.segments[match.segments.length - 1];
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

const ANSI_SEQUENCE = /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/y;

/**
 * Style the printable runs of `text`, leaving its escape sequences alone.
 *
 * Wrapping a whole slice would put the style *inside* a color the renderer had
 * already opened, and the terminal would then reset the highlight when that
 * color closes. Styling the printable runs one at a time keeps the highlight
 * outermost on each of them.
 */
function styleTextPreservingAnsi(text: string, style: (text: string) => string): string {
	const result: string[] = [];
	let plainStart = 0;
	let index = 0;
	while (index < text.length) {
		ANSI_SEQUENCE.lastIndex = index;
		const ansi = ANSI_SEQUENCE.exec(text);
		if (!ansi) {
			index += 1;
			continue;
		}
		if (index > plainStart) result.push(style(text.slice(plainStart, index)));
		result.push(ansi[0]);
		index += ansi[0].length;
		plainStart = index;
	}
	if (plainStart < text.length) result.push(style(text.slice(plainStart)));
	return result.join("");
}

/** One highlight request against a single rendered row. */
export interface TranscriptSearchHighlightRange {
	startCol: number;
	endCol: number;
	/** True for the selected match, which gets the stronger style. */
	current: boolean;
}

/**
 * Repaint `line` with every range in `ranges` highlighted.
 *
 * The line is rebuilt left to right from column slices of the *original*, so a
 * highlight never has to reason about the width of a style it just inserted.
 * Ranges are taken in column order and overlaps collapse into the first one,
 * which is why the selected match sorts ahead of a plain match starting at the
 * same column. A range past the end of the line is clipped rather than padded
 * onto it, and escape sequences trailing the last visible column are carried
 * over so a color the row opened still closes.
 */
export function highlightSearchMatchRow(
	line: string,
	ranges: readonly TranscriptSearchHighlightRange[],
	styles: TranscriptSearchHighlightStyles,
): string {
	if (ranges.length === 0) return line;
	const scannedLine = scanTerminalLine(line);
	const lineWidth = scannedLine.width;
	const ordered = [...ranges].sort((a, b) => a.startCol - b.startCol || Number(b.current) - Number(a.current));
	const pieces: string[] = [];
	let cursor = 0;
	for (const range of ordered) {
		const startCol = Math.max(cursor, range.startCol);
		const endCol = Math.min(range.endCol, lineWidth);
		if (endCol <= startCol) continue;
		if (startCol > cursor) pieces.push(sliceScannedLine(scannedLine, cursor, startCol - cursor));
		const style = range.current ? styles.currentMatch : styles.match;
		pieces.push(styleTextPreservingAnsi(sliceScannedLine(scannedLine, startCol, endCol - startCol), style));
		cursor = endCol;
	}
	if (cursor === 0) return line;
	// Ask for one column past the visible text so trailing ANSI sequences survive.
	pieces.push(sliceScannedLine(scannedLine, cursor, lineWidth - cursor + 1));
	return pieces.join("");
}
