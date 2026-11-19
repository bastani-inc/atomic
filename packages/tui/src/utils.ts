import { eastAsianWidth } from "get-east-asian-width";

// segmenters (shared instance)
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemeSegmenter;
}

/**
 * Get the shared word segmenter instance.
 */
export function getWordSegmenter(): Intl.Segmenter {
	return wordSegmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library). A repeated run of characters is matched with
// one character class, not an alternation of classes: some characters belong to several of the classes, and a repeated
// alternation then backtracks through every way to assign them before failing, which doubles the time per character.
const zeroWidthRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Mark}\p{Surrogate}]+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
// Marks that terminals allocate cells for when attached to a base character.
// This includes Unicode spacing marks and non-spacing exceptions in legacy wcwidth tables.
const terminalSpacingMarkRegex =
	/^[[\p{Spacing_Mark}--[\u1734\u302E\u302F]][\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E]]+$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

export const cjkBreakRegex =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

// CJK letters remain part of words and paths; only punctuation can separate prose from completions.
export const cjkPunctuationRegex = new RegExp(
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	"u",
);
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
export const autocompleteBoundaryRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})`, "u");

/** Whether the first `length` characters of `str` (all of them if it is shorter) are printable ASCII. */
function isPrintableAsciiPrefix(str: string, length: number): boolean {
	const end = Math.min(str.length, length);
	for (let i = 0; i < end; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

function isPrintableAscii(str: string): boolean {
	return isPrintableAsciiPrefix(str, str.length);
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}

	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	let result = "";
	let width = 0;
	let i = 0;
	let pendingAnsi = "";

	// Text between escape sequences is segmented run by run. A tab is a grapheme of its own, three columns wide.
	while (i < text.length) {
		const ansiLength = ansiCodeLength(text, i);
		if (ansiLength > 0) {
			pendingAnsi += text.substring(i, i + ansiLength);
			i += ansiLength;
			continue;
		}

		const end = nextAnsiCode(text, i + 1);
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				return { text: result, width };
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += segment;
			width += w;
		}
		i = end;
	}

	return { text: result, width };
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const hyperlinkClose = getActiveOsc8Close(prefix) + getActiveHintClose(prefix);
	const visibleWidth = prefixWidth + ellipsisWidth;
	let result: string;

	if (ellipsis.length > 0) {
		result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${hyperlinkClose}${reset}`;
	}

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
function graphemeWidth(segment: string): number {
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 0x09) return 3;
	}

	// Some marks occupy cells even without a base character.
	if (terminalSpacingMarkRegex.test(segment)) {
		return [...segment].length;
	}

	// Zero-width clusters
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	let width = eastAsianWidth(cp);

	// Intl.Segmenter can group multiple terminal-spacing code points into one
	// grapheme. Count trailing visible code points that terminals may allocate
	// cells for: Indic consonants after marks, halfwidth/fullwidth forms, and
	// Thai/Lao AM vowels.
	let followsMark = false;
	const chars = [...base];
	for (const char of chars.slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
		} else if (markCharRegex.test(char)) {
			followsMark = true;
		} else if (!nonPrintingCharRegex.test(char)) {
			const c = char.codePointAt(0)!;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) {
				// halfwidth + fullwidth forms
				width += eastAsianWidth(c);
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
			followsMark = false;
		}
	}

	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// Fast path: printable ASCII, tabs, and ANSI escape sequences. Styled lines take this path, so
	// re-rendering after a theme change does not run grapheme segmentation on every line.
	const asciiWidth = asciiVisibleWidth(str);
	if (asciiWidth !== -1) {
		return asciiWidth;
	}

	// Check cache
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	let escapeIndex = clean.indexOf("\x1b");
	if (escapeIndex !== -1) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		let stripped = "";
		let copyFrom = 0;
		while (escapeIndex !== -1) {
			const length = ansiCodeLength(clean, escapeIndex);
			if (length > 0) {
				stripped += clean.slice(copyFrom, escapeIndex);
				escapeIndex += length;
				copyFrom = escapeIndex;
			} else {
				escapeIndex++;
			}
			escapeIndex = clean.indexOf("\x1b", escapeIndex);
		}
		clean = stripped + clean.slice(copyFrom);
	}

	// Calculate width
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// Cache result
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!str.includes("\x1b")) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		result += str[i];
		i++;
	}
	return result;
}

function extractAnsiCodes(str: string): string {
	let result = "";
	let i = str.indexOf("\x1b");
	while (i !== -1) {
		const length = ansiCodeLength(str, i);
		if (length > 0) {
			result += str.substring(i, i + length);
			i += length;
		} else {
			i++;
		}
		i = str.indexOf("\x1b", i);
	}
	return result;
}

// Same character set as String.prototype.trim()
const WHITESPACE_REGEX = /\s/;

/**
 * Whether a token's visible text is only whitespace. Codes closing a styled word attach to the following space,
 * e.g. "\x1b[22m ", so they are skipped. Stops at the first visible non-whitespace text without allocating a
 * stripped copy, because styled words reach this check on every wrap.
 */
function isWhitespaceToken(token: string): boolean {
	let i = 0;
	while (i < token.length) {
		const code = token.charCodeAt(i);
		if (code === 0x1b) {
			const length = ansiCodeLength(token, i);
			if (length === 0) return false; // A lone ESC is visible text
			i += length;
		} else if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
			i++;
		} else if (code < 0x80 || !WHITESPACE_REGEX.test(token[i]!)) {
			return false;
		} else {
			i++;
		}
	}
	return true;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Replace each run of C0 and C1 control characters (ESC, BEL, newlines, ...) with one space. */
export function replaceControlCharacters(str: string): string {
	return str.replace(CONTROL_CHARACTERS, " ");
}

interface GraphemeCellRange {
	start: number;
	end: number;
}

/** Return the terminal-cell range occupied by the grapheme at a visible column. */
export function getGraphemeCellRange(line: string, column: number): GraphemeCellRange | undefined {
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		const textEnd = nextAnsiCode(line, i + 1);
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const width = graphemeWidth(segment);
			if (width > 0 && column >= currentCol && column < currentCol + width) {
				return { start: currentCol, end: currentCol + width };
			}
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

/** Return the OSC 8 hyperlink covering a visible terminal column. */
export function getOsc8LinkAtColumn(line: string, column: number): string | undefined {
	let activeUrl: string | undefined;
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			const hyperlink = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(ansi.code);
			if (hyperlink) activeUrl = hyperlink[1] || undefined;
			i += ansi.length;
			continue;
		}
		const textEnd = nextAnsiCode(line, i + 1);
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const width = segment === "\t" ? 3 : graphemeWidth(segment);
			if (column >= currentCol && column < currentCol + width) return activeUrl;
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers. Visible tabs are
 * expanded to the fixed width used by layout so terminal tab stops cannot wrap
 * a logical line, while tabs inside terminal string sequences stay untouched.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (!normalized.includes("\t")) return normalized;

	let result = "";
	let i = 0;
	while (i < normalized.length) {
		const ansi = extractAnsiCode(normalized, i);
		if (ansi) {
			result += ansi.code;
			i += ansi.length;
			continue;
		}
		result += normalized[i] === "\t" ? "   " : normalized[i];
		i++;
	}
	return result;
}

/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	const length = ansiCodeLength(str, pos);
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

/**
 * Width of a string made of printable ASCII, tabs, and ANSI escape sequences, or -1 if it contains
 * anything else. Matches `visibleWidth` for those strings without allocating.
 */
function asciiVisibleWidth(str: string): number {
	let width = 0;
	let i = 0;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code >= 0x20 && code <= 0x7e) {
			width++;
			i++;
		} else if (code === 0x09) {
			width += 3;
			i++;
		} else if (code === 0x1b) {
			const length = ansiCodeLength(str, i);
			if (length === 0) return -1;
			i += length;
		} else {
			return -1;
		}
	}
	return width;
}

/** Length of the ANSI/OSC/APC escape sequence starting at `pos`, or 0 if there is none. */
function ansiCodeLength(str: string, pos: number): number {
	if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return 0;

	const next = str.charCodeAt(pos + 1);

	// CSI sequence: ESC [ ... m/G/K/H/J
	if (next === 0x5b) {
		const end = findCsiFinal(str, pos + 2);
		return end < str.length ? end + 1 - pos : 0;
	}

	// OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
	// Used for hyperlinks (OSC 8), window titles, etc.
	// APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
	// Used for cursor marker and application-specific commands
	if (next === 0x5d || next === 0x5f) {
		const end = findStringTerminator(str, pos + 2);
		if (end === str.length) return 0;
		return (str.charCodeAt(end) === 0x07 ? end + 1 : end + 2) - pos;
	}

	return 0;
}

/**
 * A terminator search that read past `DIRECT_TERMINATOR_SEARCH` characters: no terminator lies in `[from, at)`, and
 * `at` is the terminator or the end of `text`. Another search of `text` that starts in `[from, at]` ends at `at`.
 *
 * Scanning a string asks for the sequence at every introducer, and an introducer whose terminator is far away or
 * missing is searched to that terminator or the end of the string. Without the remembered search, every introducer in
 * that span read the rest of the span again, so a string with many unterminated introducers took quadratic time.
 */
interface TerminatorSearch {
	text: string;
	from: number;
	at: number;
}

/** Characters a search reads before it consults the remembered search. Most sequences end within this distance. */
const DIRECT_TERMINATOR_SEARCH = 32;
const csiFinalSearch: TerminatorSearch = { text: "", from: 0, at: 0 };
const stringTerminatorSearch: TerminatorSearch = { text: "", from: 0, at: 0 };

function isCsiFinal(code: number): boolean {
	// m, G, K, H, J
	return code === 0x6d || code === 0x47 || code === 0x4b || code === 0x48 || code === 0x4a;
}

/** Index of the first CSI final byte at or after `from`, or `str.length` if there is none. */
function findCsiFinal(str: string, from: number): number {
	const directEnd = Math.min(str.length, from + DIRECT_TERMINATOR_SEARCH);
	let at = from;
	for (; at < directEnd; at++) {
		if (isCsiFinal(str.charCodeAt(at))) return at;
	}
	if (at === str.length) return at;

	const search = csiFinalSearch;
	if (search.text === str && search.from <= from && from <= search.at) return search.at;
	while (at < str.length && !isCsiFinal(str.charCodeAt(at))) at++;
	search.text = str;
	search.from = from;
	search.at = at;
	return at;
}

/** BEL, or ESC starting ST (ESC \). */
function isStringTerminator(str: string, index: number): boolean {
	const code = str.charCodeAt(index);
	return code === 0x07 || (code === 0x1b && str.charCodeAt(index + 1) === 0x5c);
}

/** Index of the first BEL or ST at or after `from`, or `str.length` if there is none. */
function findStringTerminator(str: string, from: number): number {
	const directEnd = Math.min(str.length, from + DIRECT_TERMINATOR_SEARCH);
	let at = from;
	for (; at < directEnd; at++) {
		if (isStringTerminator(str, at)) return at;
	}
	if (at === str.length) return at;

	const search = stringTerminatorSearch;
	if (search.text === str && search.from <= from && from <= search.at) return search.at;
	while (at < str.length && !isStringTerminator(str, at)) at++;
	search.text = str;
	search.from = from;
	search.at = at;
	return at;
}

/** Index of the first escape sequence at or after `from`, or `str.length` if there is none. */
function nextAnsiCode(str: string, from: number): number {
	let index = str.indexOf("\x1b", from);
	while (index !== -1 && ansiCodeLength(str, index) === 0) {
		index = str.indexOf("\x1b", index + 1);
	}
	return index === -1 ? str.length : index;
}

type Osc8Terminator = "\x07" | "\x1b\\";

interface ActiveHyperlink {
	params: string;
	url: string;
	terminator: Osc8Terminator;
}

function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	if (!ansiCode.startsWith("\x1b]8;")) {
		return undefined;
	}

	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	const separatorIndex = body.indexOf(";");
	if (separatorIndex === -1) {
		return undefined;
	}

	const params = body.slice(0, separatorIndex);
	const url = body.slice(separatorIndex + 1);
	if (!url) {
		return null;
	}
	return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: Osc8Terminator): string {
	return `\x1b]8;;${terminator}`;
}

/** The opening marker of a clickable key hint, which its action and a BEL follow; see clickable-hints.ts. */
export const HINT_OPEN = "\x1b_pi:h:";
/** The closing marker of a clickable key hint. */
export const HINT_CLOSE = "\x1b_pi:/h\x07";

/** The closing marker for a key hint `prefix` leaves open, or "" when it leaves none open. */
function getActiveHintClose(prefix: string): string {
	const open = prefix.lastIndexOf(HINT_OPEN);
	return open !== -1 && prefix.indexOf(HINT_CLOSE, open) === -1 ? HINT_CLOSE : "";
}

function getActiveOsc8Close(prefix: string): string {
	if (!prefix.includes("\x1b]8;")) {
		return "";
	}

	let activeHyperlink: ActiveHyperlink | null = null;
	let i = 0;
	while (i < prefix.length) {
		const ansi = extractAnsiCode(prefix, i);
		if (ansi) {
			const hyperlink = parseOsc8Hyperlink(ansi.code);
			if (hyperlink !== undefined) {
				activeHyperlink = hyperlink;
			}
			i += ansi.length;
		} else {
			i++;
		}
	}
	return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"
	private activeHyperlink: ActiveHyperlink | null = null;
	/** The opening marker of the key hint the text is inside, closed at a line's end and re-opened on the next. */
	private activeHint: string | null = null;

	process(ansiCode: string): void {
		if (ansiCode.startsWith(HINT_OPEN)) {
			this.activeHint = ansiCode;
			return;
		}
		if (ansiCode === HINT_CLOSE) {
			this.activeHint = null;
			return;
		}

		// OSC 8 hyperlink: \x1b]8;;<url>\x1b\\ (open) or \x1b]8;;\x1b\\ (close).
		// Preserve the original terminator because some terminals only make BEL-terminated
		// links clickable. OAuth login URLs use BEL, so reopening wrapped lines with ST
		// made only the first physical line clickable in those terminals.
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		if (hyperlink !== undefined) {
			this.activeHyperlink = hyperlink;
			return;
		}

		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Extract the parameters between \x1b[ and m
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			// Full reset
			this.reset();
			return;
		}

		// Parse parameters (can be semicolon-separated)
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// Handle 256-color and RGB codes which consume multiple parameters
			if (code === 38 || code === 48) {
				// 38;5;N (256 color fg) or 38;2;R;G;B (RGB fg)
				// 48;5;N (256 color bg) or 48;2;R;G;B (RGB bg)
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 color: 38;5;N or 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB color: 38;2;R;G;B or 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// Standard SGR codes
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break; // Some terminals
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break; // Default fg
				case 49:
					this.bgColor = null;
					break; // Default bg
				default:
					// Standard foreground colors 30-37, 90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// Standard background colors 40-47, 100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
		// SGR reset does not affect OSC 8 hyperlink or key hint state
	}

	/** Clear all state for reuse. */
	clear(): void {
		this.reset();
		this.activeHyperlink = null;
		this.activeHint = null;
	}

	/** The closing marker of the key hint the text is inside, or "" outside one. */
	getHintClose(): string {
		return this.activeHint === null ? "" : HINT_CLOSE;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		if (this.activeHyperlink) {
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		if (this.activeHint) {
			result += this.activeHint;
		}
		return result;
	}

	getActiveBackgroundCode(): string {
		return this.bgColor ? `\x1b[${this.bgColor}m` : "";
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null ||
			this.activeHyperlink !== null ||
			this.activeHint !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Underline and strikethrough must be closed to prevent bleeding into padding.
	 * Active OSC 8 hyperlinks and key hints must be closed and re-opened on the next line.
	 * Returns empty string if no attributes need closing.
	 */
	getLineEndReset(): string {
		let result = "";
		if (this.underline) {
			result += "\x1b[24m"; // Underline off only
		}
		if (this.strikethrough) {
			result += "\x1b[29m"; // Strikethrough off only, re-opened at line start via getActiveCodes()
		}
		if (this.activeHyperlink) {
			result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
		}
		return result + this.getHintClose(); // Re-opened at line start via getActiveCodes()
	}
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = text.indexOf("\x1b");
	while (i !== -1) {
		const length = ansiCodeLength(text, i);
		if (length > 0) {
			tracker.process(text.substring(i, i + length));
			i += length;
		} else {
			i++;
		}
		i = text.indexOf("\x1b", i);
	}
}

/** Return only the background color active at the end of an ANSI-styled string. */
export function getActiveBackgroundAnsi(text: string): string {
	const tracker = new AnsiCodeTracker();
	updateTrackerFromText(text, tracker);
	return tracker.getActiveBackgroundCode();
}

function* graphemeSegments(text: string): Generator<string> {
	for (const { segment } of graphemeSegmenter.segment(text)) yield segment;
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let pendingAnsi = ""; // ANSI codes waiting to be attached to next visible content
	let currentKind: "space" | "word" | null = null;
	let i = 0;

	const flushCurrent = (): void => {
		if (!current) {
			return;
		}
		tokens.push(current);
		current = "";
		currentKind = null;
	};

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			// Hold ANSI codes separately - they'll be attached to the next visible char
			pendingAnsi += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		// Visible text runs up to the next escape sequence.
		const end = nextAnsiCode(text, i + 1);

		const chunk = text.slice(i, end);
		// Printable ASCII characters are single graphemes, so skip the segmenter for them.
		const ascii = isPrintableAscii(chunk);
		for (const segment of ascii ? chunk : graphemeSegments(chunk)) {
			const segmentIsSpace = segment === " ";
			if (!ascii && !segmentIsSpace && cjkBreakRegex.test(segment)) {
				flushCurrent();
				const token = pendingAnsi + segment;
				pendingAnsi = "";
				tokens.push(token);
				continue;
			}

			const segmentKind = segmentIsSpace ? "space" : "word";
			if (current && currentKind !== segmentKind) {
				flushCurrent();
			}

			// Attach any pending ANSI codes to this visible character
			if (pendingAnsi) {
				current += pendingAnsi;
				pendingAnsi = "";
			}

			currentKind = segmentKind;
			current += segment;
		}

		i = end;
	}

	// Handle any remaining pending ANSI codes (attach to last token)
	if (pendingAnsi) {
		if (current) {
			current += pendingAnsi;
		} else if (tokens.length > 0) {
			tokens[tokens.length - 1] += pendingAnsi;
		} else {
			current = pendingAnsi;
		}
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
/**
 * Flatten cached lines. V8 keeps a string built by concatenation as a tree of its parts until something reads it
 * whole, and a cached line kept as such a tree retains several times its own size. Converting a string to a number
 * reads it whole, so V8 flattens it in place; the strings' values do not change.
 */
export function flattenLines(lines: readonly string[]): void {
	for (const line of lines) Number(line);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// Handle newlines by processing each line separately
	// Track ANSI state across lines so styles carry over after literal newlines
	const inputLines = text.split(/\r\n|\r|\n/);
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// Prepend active ANSI codes from previous lines (except for first line)
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		// A key hint open across the newline ends with this line's text, so padding or a border after it is not part
		// of the hint; the next line re-opens it.
		if (result.length > 0) result[result.length - 1] += tracker.getHintClose();
		const wrappedLines = wrapSingleLine(prefix + inputLine, width);
		for (const wrappedLine of wrappedLines) {
			result.push(wrappedLine);
		}
		// Update tracker with codes from this line for next iteration
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

function hintMarkerLength(line: string, index: number): number {
	if (line.startsWith(HINT_CLOSE, index)) return HINT_CLOSE.length;
	return line.startsWith(HINT_OPEN, index) ? ansiCodeLength(line, index) : 0;
}

/** Hint markers carry the active action across a wrap but do not by themselves make a row. */
function hasWrapContent(line: string): boolean {
	for (let i = 0; i < line.length; ) {
		const length = hintMarkerLength(line, i);
		if (!length) return true;
		i += length;
	}
	return false;
}

/** Trim the same spaces as the unmarked row, retaining any hint markers among them. */
function trimWrapEnd(line: string): string {
	const trimmed = line.trimEnd();
	if (!trimmed.endsWith("\x07")) return trimmed;
	let end = trimmed.length;
	const markers: string[] = [];
	while (end > 0 && trimmed.charCodeAt(end - 1) === 7) {
		const start = trimmed.lastIndexOf("\x1b", end - 1);
		if (start < 0 || hintMarkerLength(trimmed, start) !== end - start) break;
		markers.push(trimmed.slice(start, end));
		end = start;
		while (end > 0 && WHITESPACE_REGEX.test(trimmed[end - 1]!)) end--;
	}
	return markers.length ? trimmed.slice(0, end) + markers.reverse().join("") : trimmed;
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) {
		return [""];
	}

	const visibleLength = visibleWidth(line);
	if (visibleLength <= width) {
		return [line];
	}

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const tokens = splitIntoTokensWithAnsi(line);

	let currentLine = "";
	let currentVisibleLength = 0;

	for (const token of tokens) {
		const tokenVisibleLength = visibleWidth(token);
		const isWhitespace = isWhitespaceToken(token);

		// Token itself is too long - break it character by character
		if (tokenVisibleLength > width && !isWhitespace) {
			if (hasWrapContent(currentLine)) {
				// Trim before adding the reset, which would otherwise block the final trimEnd()
				currentLine = trimWrapEnd(currentLine);
				// Add specific reset for underline only (preserves background)
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				wrapped.push(currentLine);
				currentLine = "";
				currentVisibleLength = 0;
			}

			// Break long token - breakLongWord handles its own resets
			const broken = breakLongWord(token, width, tracker);
			for (let i = 0; i < broken.length - 1; i++) {
				wrapped.push(broken[i]!);
			}
			currentLine = broken[broken.length - 1];
			currentVisibleLength = visibleWidth(currentLine);
			continue;
		}

		// Check if adding this token would exceed width
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		if (totalNeeded > width && currentVisibleLength > 0) {
			// Trim trailing whitespace, then add underline reset (not full reset, to preserve background)
			let lineToWrap = trimWrapEnd(currentLine);
			if (isWhitespace) {
				// The dropped space may carry codes (e.g. closing a styled word). Keep them on the wrapped line so
				// the style ends there and is not re-opened on the next line.
				lineToWrap += extractAnsiCodes(token);
				updateTrackerFromText(token, tracker);
			}
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				lineToWrap += lineEndReset;
			}
			wrapped.push(lineToWrap);
			if (isWhitespace) {
				// Don't start new line with whitespace
				currentLine = tracker.getActiveCodes();
				currentVisibleLength = 0;
				continue;
			}
			currentLine = tracker.getActiveCodes() + token;
			currentVisibleLength = tokenVisibleLength;
		} else if (
			isWhitespace &&
			totalNeeded > width &&
			token.includes("\x1b") &&
			hasWrapContent(extractAnsiCodes(token))
		) {
			// Whitespace wider than an empty line. Plain spaces are removed by the final trimEnd(), but codes after
			// them (e.g. a trailing reset) would block that and leave the line wider than width. Keep only the codes.
			currentLine += extractAnsiCodes(token);
		} else {
			// Add to current line
			currentLine += token;
			currentVisibleLength += tokenVisibleLength;
		}

		updateTrackerFromText(token, tracker);
	}

	if (hasWrapContent(currentLine)) {
		// No reset at end of final line - let caller handle it
		wrapped.push(currentLine);
	}

	// Trailing whitespace can cause lines to exceed the requested width
	return wrapped.length > 0 ? wrapped.map(trimWrapEnd) : [""];
}

export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

/**
 * The longest prefix of a grapheme cluster, cut between code points, that is at most `maxWidth` columns wide. It is
 * empty when even the first code point is wider. `grapheme` must be wider than `maxWidth`. A grapheme cluster cannot be
 * wrapped, so the editor and `wrapTextWithAnsi` show one wider than the line clipped.
 */
export function clipGraphemeToWidth(grapheme: string, maxWidth: number): string {
	// Code-unit offset after each code point, so no cut splits a surrogate pair.
	const codePointEnds: number[] = [];
	for (let i = 0; i < grapheme.length; ) {
		i += grapheme.codePointAt(i)! > 0xffff ? 2 : 1;
		codePointEnds.push(i);
	}
	const fits = (codePoints: number): boolean =>
		visibleWidth(grapheme.slice(0, codePointEnds[codePoints - 1])) <= maxWidth;

	// A longer prefix of a cluster is almost always at least as wide. Gallop and then bisect for a prefix that fits
	// followed by a code point that does not, so a cluster of n code points is measured O(log n) times, not n.
	let fitting = 0;
	let overflowing = codePointEnds.length;
	for (let step = 1; fitting + step < overflowing; step *= 2) {
		if (!fits(fitting + step)) {
			overflowing = fitting + step;
			break;
		}
		fitting += step;
	}
	while (overflowing - fitting > 1) {
		const middle = (fitting + overflowing) >>> 1;
		if (fits(middle)) fitting = middle;
		else overflowing = middle;
	}
	return fitting === 0 ? "" : grapheme.slice(0, codePointEnds[fitting - 1]);
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// First, separate ANSI codes from visible content
	// We need to handle ANSI codes specially since they're not graphemes
	let i = 0;
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	while (i < word.length) {
		const ansiResult = extractAnsiCode(word, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// Find the next ANSI code or end of string
			const end = nextAnsiCode(word, i + 1);
			// Segment this non-ANSI portion into graphemes
			const textPortion = word.slice(i, end);
			for (const seg of graphemeSegmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	// Now process segments
	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// Skip empty graphemes to avoid issues with string-width calculation
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		// Break before a grapheme that does not fit, unless the line has nothing visible yet: a cluster wider than the
		// line then takes the empty line rather than leaving it empty.
		if (currentWidth > 0 && currentWidth + graphemeWidth > width) {
			// Add specific reset for underline only (preserves background)
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				currentLine += lineEndReset;
			}
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		if (graphemeWidth > width) {
			// A grapheme cluster cannot be broken, so it is clipped between code points and fills the line.
			currentLine += clipGraphemeToWidth(grapheme, width);
			currentWidth = width;
			continue;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		// No reset at end of final segment - caller handles continuation
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	const withPadding = line + padding;
	return bgFn(withPadding);
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "...")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	if (maxWidth <= 0) {
		return "";
	}

	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = visibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	// Printable ASCII characters are one column each and never join the grapheme after them, so when the first
	// maxWidth + 1 characters are printable ASCII the text overflows there, whatever follows, and is cut after the first
	// targetWidth characters.
	if (isPrintableAsciiPrefix(text, maxWidth + 1)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pendingAnsi = "";
	let visibleSoFar = 0;
	let keptWidth = 0;
	let keepContiguousPrefix = true;
	let i = 0;

	// One pass that stops at the first grapheme past maxWidth. Text between escape sequences is segmented run by run,
	// and a tab is a grapheme of its own, three columns wide.
	scan: while (i < text.length) {
		const ansiLength = ansiCodeLength(text, i);
		if (ansiLength > 0) {
			pendingAnsi += text.substring(i, i + ansiLength);
			i += ansiLength;
			continue;
		}

		const end = nextAnsiCode(text, i + 1);
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			const width = graphemeWidth(segment);
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				keptWidth += width;
			} else {
				keepContiguousPrefix = false;
				pendingAnsi = "";
			}

			visibleSoFar += width;
			if (visibleSoFar > maxWidth) {
				break scan;
			}
		}
		i = end;
	}

	if (visibleSoFar <= maxWidth) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(
	line: string,
	startCol: number,
	length: number,
	strict = false,
): { text: string; width: number } {
	if (length <= 0) return { text: "", width: 0 };
	const endCol = startCol + length;
	let result = "",
		resultWidth = 0,
		currentCol = 0,
		i = 0,
		pendingAnsi = "";

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			// APC sequences (cursor markers) are positional one-shot commands, not persistent style
			// state, so codes before the range carry over only when they are not APC.
			if (currentCol >= startCol && currentCol < endCol) {
				// Keep original order: codes from before the range must precede codes at the boundary
				result += pendingAnsi + ansi.code;
				pendingAnsi = "";
			} else if (currentCol < startCol && !ansi.code.startsWith("\x1b_")) pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		const textEnd = nextAnsiCode(line, i + 1);

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = !strict || currentCol + w <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
				resultWidth += w;
			}
			currentCol += w;
			if (currentCol >= endCol) break;
		}
		i = textEnd;
		if (currentCol >= endCol) break;
	}
	return { text: result, width: resultWidth };
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	let before = "",
		beforeWidth = 0,
		after = "",
		afterWidth = 0;
	let currentCol = 0,
		i = 0;
	let pendingAnsiBefore = "";
	let afterStarted = false;
	const afterEnd = afterStart + afterLen;

	// Track styling state so "after" inherits styling from before the overlay
	pooledStyleTracker.clear();

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			// Track all SGR codes to know styling state at afterStart
			pooledStyleTracker.process(ansi.code);
			// Include ANSI codes in their respective segments
			if (currentCol < beforeEnd) {
				pendingAnsiBefore += ansi.code;
			} else if (
				currentCol >= afterStart &&
				currentCol < afterEnd &&
				(afterStarted || ansi.code.startsWith("\x1b_"))
			) {
				// SGR codes are only included after "after" started (styling already prepended). Zero-width APC
				// markers like CURSOR_MARKER are not tracked styling, so keep them at the boundary too.
				after += ansi.code;
			}
			i += ansi.length;
			continue;
		}

		const textEnd = nextAnsiCode(line, i + 1);

		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const w = graphemeWidth(segment);

			if (currentCol < beforeEnd && currentCol + w <= beforeEnd) {
				if (pendingAnsiBefore) {
					before += pendingAnsiBefore;
					pendingAnsiBefore = "";
				}
				before += segment;
				beforeWidth += w;
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				const fits = !strictAfter || currentCol + w <= afterEnd;
				if (fits) {
					// On first "after" grapheme, prepend inherited styling from before overlay
					if (!afterStarted) {
						after += pooledStyleTracker.getActiveCodes();
						afterStarted = true;
					}
					after += segment;
					afterWidth += w;
				}
			}

			currentCol += w;
			// Early exit: done with "before" only, or done with both segments
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		i = textEnd;
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	return { before, beforeWidth, after, afterWidth };
}
