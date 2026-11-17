/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { EditInputError, EditMatchError, EditTargetError } from "./file-tool-errors.ts";
import { resolveToCwdAsync } from "./path-utils.ts";

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself.
 * Text outside the replaced ranges keeps its bytes, including its line endings. Line breaks in
 * the new text get the line ending of the line where the replaced range starts. The result,
 * normalized to LF, equals the replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: TextReplacement[]): string {
	// Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at
	// p - n in the normalized text. Adding the number of CRLFs before a normalized offset gives the
	// original offset, and a range that covers that LF covers the whole CRLF.
	let crlfBefore = 0;
	let nextCrlf = originalContent.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};

	const parts: string[] = [];
	let endsWithCr = false;
	const push = (part: string): void => {
		if (part.length === 0) return;
		// A CR before a seam and an LF after it would merge into one CRLF line break, for example a kept
		// lone CR followed by inserted text that starts with LF, or both sides of a deleted range. Adding
		// an LF turns the CR into a CRLF of its own, so the written file has the line breaks the diff shows.
		if (endsWithCr && part[0] === "\n") parts.push("\n");
		parts.push(part);
		endsWithCr = part[part.length - 1] === "\r";
	};
	let position = 0;
	for (const replacement of replacements) {
		const start = toOriginal(replacement.matchIndex);
		push(originalContent.slice(position, start));
		const ending = getLineEndingAt(originalContent, start);
		push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = toOriginal(replacement.matchIndex + replacement.matchLength);
	}
	push(originalContent.slice(position));
	return parts.join("");
}

/**
 * Line ending of the line containing `offset`: its own LF or CRLF, or that of the line before
 * for an unterminated last line. A lone CR only counts in files without any LF (classic Mac
 * line endings); elsewhere it is more likely a control character inside a line.
 */
function getLineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
	let lineFeed = content.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
	if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
	return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/** Range of `matchLength` characters at `matchIndex`. */
interface TextRange {
	matchIndex: number;
	matchLength: number;
}

interface MatchedEdit extends TextRange {
	editIndex: number;
	newText: string;
}

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	/** Sorted replacements of `baseContent` that turn it into `newContent` */
	replacements: TextReplacement[];
}

/** Apply sorted, disjoint replacements. */
function applyReplacements(content: string, replacements: TextReplacement[]): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		result =
			result.substring(0, replacement.matchIndex) +
			replacement.newText +
			result.substring(replacement.matchIndex + replacement.matchLength);
	}
	return result;
}

/** A piece of the original text and the fuzzy-normalized text it became. */
interface FuzzyPiece {
	/** Offset of the piece in the normalized text */
	normalizedStart: number;
	normalizedLength: number;
	/** Offset of the piece in the original text */
	originalStart: number;
	originalLength: number;
	/** Whether every offset inside the piece maps one to one, not only its ends */
	identity: boolean;
}

/** Fuzzy-normalized text with the pieces that map its offsets back to the original. */
interface FuzzyText {
	text: string;
	pieces: FuzzyPiece[];
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Normalize text for fuzzy matching, keeping a map back to the original offsets:
 * - Normalize Unicode compatibility forms (NFKC), such as full-width characters
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 *
 * NFKC is applied per grapheme cluster, so composition stays inside one user-perceived character and each
 * cluster maps to a known original range. ASCII lines need no NFKC and map one to one.
 */
function toFuzzyText(content: string): FuzzyText {
	const parts: string[] = [];
	const pieces: FuzzyPiece[] = [];
	let normalizedOffset = 0;
	const addPiece = (originalStart: number, originalLength: number, normalized: string, identity: boolean): void => {
		parts.push(normalized);
		pieces.push({
			normalizedStart: normalizedOffset,
			normalizedLength: normalized.length,
			originalStart,
			originalLength,
			identity,
		});
		normalizedOffset += normalized.length;
	};

	for (let lineStart = 0; ; ) {
		const lineFeed = content.indexOf("\n", lineStart);
		const lineEnd = lineFeed === -1 ? content.length : lineFeed;
		const line = content.slice(lineStart, lineEnd);
		if (ASCII_ONLY.test(line)) {
			const kept = line.trimEnd();
			if (kept.length > 0) addPiece(lineStart, kept.length, kept, true);
		} else {
			const clusters = [...graphemeSegmenter.segment(line)].map(({ index, segment }) => ({
				index,
				segment,
				normalized: segment.normalize("NFKC"),
			}));
			let remaining = clusters
				.map((cluster) => cluster.normalized)
				.join("")
				.trimEnd().length;
			for (const cluster of clusters) {
				if (remaining === 0) break;
				// Trailing whitespace may end inside the last kept cluster; the cluster still maps whole.
				const normalized = cluster.normalized.slice(0, remaining);
				remaining -= normalized.length;
				addPiece(lineStart + cluster.index, cluster.segment.length, normalized, false);
			}
		}
		if (lineFeed === -1) break;
		addPiece(lineFeed, 1, "\n", true);
		lineStart = lineFeed + 1;
	}

	const text = parts
		.join("")
		// Smart single quotes → '
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		// Smart double quotes → "
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		// Various dashes/hyphens → -
		// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
		// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		// Special spaces → regular space
		// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
		// U+205F medium math space, U+3000 ideographic space
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
	return { text, pieces };
}

/** The piece whose normalized text contains `offset`, or ends at it when `atEnd`. */
function findPiece(pieces: FuzzyPiece[], offset: number, atEnd: boolean): FuzzyPiece {
	let low = 0;
	let high = pieces.length - 1;
	while (low < high) {
		const middle = (low + high) >> 1;
		const piece = pieces[middle];
		const pieceEnd = piece.normalizedStart + piece.normalizedLength;
		if (atEnd ? pieceEnd < offset : pieceEnd <= offset) low = middle + 1;
		else high = middle;
	}
	return pieces[low];
}

/**
 * Original range of the normalized range `[start, end)`, or undefined when either end falls inside one
 * original character that normalization expanded: replacing it would also change the rest of that character.
 */
function toOriginalRange(fuzzy: FuzzyText, start: number, end: number): { start: number; end: number } | undefined {
	const first = findPiece(fuzzy.pieces, start, false);
	const last = findPiece(fuzzy.pieces, end, true);
	const startInside = start - first.normalizedStart;
	const endInside = end - last.normalizedStart;
	if (startInside !== 0 && !first.identity) return undefined;
	if (endInside !== last.normalizedLength && !last.identity) return undefined;
	return {
		start: first.originalStart + startInside,
		end:
			endInside === last.normalizedLength
				? last.originalStart + last.originalLength
				: last.originalStart + endInside,
	};
}

/** Every start offset of `needle` in `haystack`, overlapping occurrences included. */
function findOccurrences(haystack: string, needle: string): number[] {
	const offsets: number[] = [];
	for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
		offsets.push(index);
	}
	return offsets;
}

/**
 * Original ranges that `oldText` matches. An exact match always wins: fuzzy matching runs only when `oldText`
 * does not occur verbatim, and then only locates ranges. Ranges whose ends fall inside one original
 * character are left out.
 */
function findMatches(content: string, oldText: string, getFuzzyContent: () => FuzzyText): TextRange[] {
	const exact = findOccurrences(content, oldText);
	if (exact.length > 0) return exact.map((index) => ({ matchIndex: index, matchLength: oldText.length }));

	const fuzzyOldText = toFuzzyText(oldText).text;
	// Whitespace-only text normalizes to nothing, which would match everywhere.
	if (fuzzyOldText.length === 0) return [];
	const fuzzyContent = getFuzzyContent();
	const matches: TextRange[] = [];
	for (const index of findOccurrences(fuzzyContent.text, fuzzyOldText)) {
		const range = toOriginalRange(fuzzyContent, index, index + fuzzyOldText.length);
		if (range) matches.push({ matchIndex: range.start, matchLength: range.end - range.start });
	}
	return matches;
}

/**
 * Decode a file for editing. Refuses text that is not valid UTF-8: decoding it would replace the invalid
 * bytes with U+FFFD, and writing the result back would corrupt lines the edit never touched.
 */
export function decodeUtf8ForEdit(buffer: Uint8Array, path: string): string {
	try {
		// ignoreBOM keeps a byte order mark in the text, so the caller can write it back.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	} catch (error: unknown) {
		throw new EditTargetError(
			"target-not-utf8",
			`Could not edit file: ${path}. It is not valid UTF-8 text, and edit would corrupt its other bytes. The file was left unchanged.`,
			{ path },
			{ cause: error },
		);
	}
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): EditMatchError {
	const fields = { path, editIndex, totalEdits };
	if (totalEdits === 1) {
		return new EditMatchError(
			"text-not-found",
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
			fields,
		);
	}
	return new EditMatchError(
		"text-not-found",
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
		fields,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): EditMatchError {
	const fields = { path, editIndex, totalEdits, occurrences };
	if (totalEdits === 1) {
		return new EditMatchError(
			"text-not-unique",
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
			fields,
		);
	}
	return new EditMatchError(
		"text-not-unique",
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
		fields,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): EditInputError {
	const fields = { path, editIndex, totalEdits };
	if (totalEdits === 1) {
		return new EditInputError("old-text-empty", `oldText must not be empty in ${path}.`, fields);
	}
	return new EditInputError("old-text-empty", `edits[${editIndex}].oldText must not be empty in ${path}.`, fields);
}

function getSplitCharacterError(path: string, editIndex: number, totalEdits: number): EditInputError {
	const fields = { path, editIndex, totalEdits };
	const edit = totalEdits === 1 ? "oldText or newText" : `edits[${editIndex}].oldText or newText`;
	return new EditInputError(
		"text-splits-character",
		`${edit} contains half of a surrogate pair in ${path}. Replacing it would split a character and corrupt the text next to the match. The file was left unchanged.`,
		fields,
	);
}

function getNoChangeError(path: string, totalEdits: number): EditMatchError {
	if (totalEdits === 1) {
		return new EditMatchError(
			"no-change",
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
			{ path, totalEdits },
		);
	}
	return new EditMatchError("no-change", `No changes made to ${path}. The replacements produced identical content.`, {
		path,
		totalEdits,
	});
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. An edit whose oldText
 * does not occur verbatim falls back to fuzzy matching, which only locates the
 * original range to replace: newText is spliced into the original content, so
 * no text outside the matched ranges changes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		const { oldText, newText } = normalizedEdits[i];
		if (oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
		// The file is valid UTF-8, so a match can only start or end inside a surrogate pair when oldText starts
		// or ends with a lone surrogate. Refusing lone surrogates keeps every match on character boundaries.
		if (!oldText.isWellFormed() || !newText.isWellFormed()) {
			throw getSplitCharacterError(path, i, normalizedEdits.length);
		}
	}

	let fuzzyContent: FuzzyText | undefined;
	const getFuzzyContent = (): FuzzyText => {
		fuzzyContent ??= toFuzzyText(normalizedContent);
		return fuzzyContent;
	};
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matches = findMatches(normalizedContent, edit.oldText, getFuzzyContent);
		if (matches.length === 0) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}
		if (matches.length > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, matches.length);
		}
		matchedEdits.push({ editIndex: i, ...matches[0], newText: edit.newText });
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new EditMatchError(
				"edits-overlap",
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
				{
					path,
					editIndex: current.editIndex,
					totalEdits: normalizedEdits.length,
					overlapsEditIndex: previous.editIndex,
				},
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = applyReplacements(baseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, replacements: matchedEdits };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const lineNumWidth = String(Math.max(countLines(oldContent), countLines(newContent))).length;
	const { output, firstChangedLine } = formatDisplayDiff(
		Diff.diffLines(oldContent, newContent),
		1,
		1,
		lineNumWidth,
		contextLines,
	);
	return { diff: output.join("\n"), firstChangedLine };
}

/** Number of lines as `text.split("\n").length` counts them, without building the array. */
function countLines(text: string): number {
	return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text: string, start: number, end: number): number {
	let count = 0;
	for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
		count++;
	}
	return count;
}

/** Format jsdiff line parts as display diff lines, numbering from the given 1-based old and new lines. */
function formatDisplayDiff(
	parts: Diff.ChangeObject<string>[],
	oldStartLine: number,
	newStartLine: number,
	lineNumWidth: number,
	contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
	const output: string[] = [];

	let oldLineNum = oldStartLine;
	let newLineNum = newStartLine;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { output, firstChangedLine };
}

/** Display diff and unified patch of an edit, as returned in the edit tool's details. */
export interface EditDiff {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
}

/**
 * Unchanged lines diffed on each side of a replacement. Well above the 4 context lines shown, so jsdiff
 * aligns a change within its window as it would over the whole file.
 */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Diff an edit only around its replacements, so time and memory follow the size of the change instead of
 * the file. The result matches generateDiffString and generateUnifiedPatch over the whole contents, except
 * that jsdiff may align runs of repeated lines differently within a window.
 */
export function generateEditDiff(
	path: string,
	baseContent: string,
	newContent: string,
	replacements: TextReplacement[],
	contextLines = 4,
): EditDiff {
	const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length;
	const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
	const output: string[] = [];
	const hunks: Diff.StructuredPatchHunk[] = [];
	let firstChangedLine: number | undefined;
	for (const window of getDiffWindows(baseContent, replacements)) {
		const oldText = baseContent.slice(window.oldStart, window.oldEnd);
		const newText = newContent.slice(window.newStart, window.newEnd);
		const shown = formatDisplayDiff(
			Diff.diffLines(oldText, newText),
			window.oldLine + 1,
			window.newLine + 1,
			lineNumWidth,
			contextLines,
		);
		firstChangedLine ??= shown.firstChangedLine;
		// Both windows around a run of unchanged lines mark it as skipped; the whole-file diff shows one marker.
		if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
		// A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
		for (const line of shown.output) output.push(line);
		const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, { context: contextLines });
		for (const hunk of patch.hunks) {
			hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
		}
	}
	const patch = Diff.formatPatch(
		{ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
		Diff.FILE_HEADERS_ONLY,
	);
	return { diff: output.join("\n"), patch, firstChangedLine };
}

/** Matching ranges of the old and new contents around one or more replacements: offsets and 0-based first lines. */
interface DiffWindow {
	oldStart: number;
	oldEnd: number;
	oldLine: number;
	newStart: number;
	newEnd: number;
	newLine: number;
}

/** Start of the line that contains `offset`. */
function lineStartBefore(text: string, offset: number): number {
	// lastIndexOf treats a negative position as 0 and would find a line feed at offset 0.
	return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** Whole-line windows with margin around the replacements, which are sorted and disjoint; overlapping windows merge. */
function getDiffWindows(baseContent: string, replacements: TextReplacement[]): DiffWindow[] {
	const windows: DiffWindow[] = [];
	// Offset and line deltas of the replacements before the current one, and a line-counting cursor.
	let offsetDelta = 0;
	let lineDelta = 0;
	let cursorOffset = 0;
	let cursorLine = 0;
	for (const replacement of replacements) {
		const matchEnd = replacement.matchIndex + replacement.matchLength;
		let start = lineStartBefore(baseContent, replacement.matchIndex);
		for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
			start = lineStartBefore(baseContent, start - 1);
		}
		let end = matchEnd;
		for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
			const lineFeed = baseContent.indexOf("\n", i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end);
			end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
		}
		const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
		const replacementLineDelta =
			countLineFeeds(replacement.newText, 0, replacement.newText.length) -
			countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
		const previous = windows.at(-1);
		if (previous && start <= previous.oldEnd) {
			previous.oldEnd = Math.max(previous.oldEnd, end);
			previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
		} else {
			cursorLine += countLineFeeds(baseContent, cursorOffset, start);
			cursorOffset = start;
			windows.push({
				oldStart: start,
				oldEnd: end,
				oldLine: cursorLine,
				newStart: start + offsetDelta,
				newEnd: end + offsetDelta + replacementOffsetDelta,
				newLine: cursorLine + lineDelta,
			});
		}
		offsetDelta += replacementOffsetDelta;
		lineDelta += replacementLineDelta;
	}
	return windows;
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = await resolveToCwdAsync(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = decodeUtf8ForEdit(await readFile(absolutePath), path);

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		const { diff, firstChangedLine } = generateEditDiff(path, baseContent, newContent, replacements);
		return { diff, firstChangedLine };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
