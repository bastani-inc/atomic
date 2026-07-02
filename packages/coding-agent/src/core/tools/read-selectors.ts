export interface ReadLineRange { start: number; end?: number }

export interface ReadLineSelector {
	path: string;
	offset?: number;
	limit?: number;
	ranges?: ReadLineRange[];
	raw?: boolean;
	conflicts?: boolean;
}

const ARCHIVE_SELECTOR_EXTENSIONS = [".tar.gz", ".zip", ".jar", ".tar", ".tgz", ".gz"];
const RESOURCE_SELECTOR_EXTENSIONS = [".tar.gz", ".sqlite", ".zip", ".jar", ".tar", ".tgz", ".gz", ".db"];

function isAsciiDigit(char: string | undefined): boolean { return char !== undefined && char >= "0" && char <= "9"; }
function hasUrlScheme(value: string): boolean {
	const schemeEnd = value.indexOf("://");
	if (schemeEnd <= 0) return false;
	for (let index = 0; index < schemeEnd; index++) {
		const char = value[index]!;
		if (!((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"))) return false;
	}
	return true;
}
function selectorExtensionColonIndex(value: string, extensions: readonly string[]): number {
	const lower = value.toLowerCase();
	let best = Number.POSITIVE_INFINITY;
	for (const extension of extensions) {
		let from = 0;
		for (;;) {
			const extensionIndex = lower.indexOf(`${extension}:`, from);
			if (extensionIndex < 0) break;
			if (extensionIndex > 0) best = Math.min(best, extensionIndex + extension.length);
			from = extensionIndex + 1;
		}
	}
	return Number.isFinite(best) ? best : -1;
}

export function isReadResourceSelector(pathValue: string): boolean {
	return selectorExtensionColonIndex(pathValue, RESOURCE_SELECTOR_EXTENSIONS) >= 0 || hasUrlScheme(pathValue) || pathValue.startsWith("skill://");
}
function archiveSelectorColonIndex(value: string): number { return selectorExtensionColonIndex(value, ARCHIVE_SELECTOR_EXTENSIONS); }
function isArchiveSelectorPath(value: string): boolean { return archiveSelectorColonIndex(value) >= 0; }
function hasArchiveMember(value: string): boolean { const colonIndex = archiveSelectorColonIndex(value); return colonIndex >= 0 && colonIndex < value.length - 1; }
function peelArchiveReadSuffixes(value: string, state: { raw: boolean; conflicts: boolean }): string {
	let working = value;
	for (;;) {
		const lower = working.toLowerCase();
		if (lower.endsWith(":raw")) { state.raw = true; working = working.slice(0, -4); continue; }
		if (lower.endsWith(":conflicts")) { state.conflicts = true; working = working.slice(0, -10); continue; }
		return working;
	}
}
function findInlineSelector(value: string, selector: "raw" | "conflicts"): number {
	const needle = `:${selector}`;
	let index = 0;
	for (;;) {
		const found = value.toLowerCase().indexOf(needle, index);
		if (found < 0) return -1;
		const next = value[found + needle.length];
		if (next === undefined || next === ":") return found;
		index = found + needle.length;
	}
}
function peelInlineReadSuffixes(value: string, state: { raw: boolean; conflicts: boolean }): string {
	let working = value;
	for (;;) {
		const rawIndex = findInlineSelector(working, "raw");
		if (rawIndex >= 0) { state.raw = true; working = `${working.slice(0, rawIndex)}${working.slice(rawIndex + 4)}`; continue; }
		const conflictIndex = findInlineSelector(working, "conflicts");
		if (conflictIndex >= 0) { state.conflicts = true; working = `${working.slice(0, conflictIndex)}${working.slice(conflictIndex + 10)}`; continue; }
		return working;
	}
}
function startsLikeLineRange(value: string): boolean {
	let index = value[0]?.toLowerCase() === "l" ? 1 : 0;
	return isAsciiDigit(value[index]);
}
function readNumber(value: string, start: number): { value: number; end: number } | undefined {
	let index = start;
	while (isAsciiDigit(value[index])) index++;
	if (index === start) return undefined;
	return { value: Number.parseInt(value.slice(start, index), 10), end: index };
}
function parseLineRangeToken(token: string, invalid: (message: string) => void): ReadLineRange | undefined {
	let index = token[0]?.toLowerCase() === "l" ? 1 : 0;
	const startNumber = readNumber(token, index);
	if (!startNumber) return undefined;
	const start = startNumber.value;
	if (start < 1) { invalid("Line selector 0 is invalid; lines are 1-indexed. Use :1."); return undefined; }
	index = startNumber.end;
	if (index === token.length) return { start };
	let separator: "-" | ".." | "+" | undefined;
	if (token.startsWith("..", index)) { separator = ".."; index += 2; }
	else if (token[index] === "-" || token[index] === "+") { separator = token[index] as "-" | "+"; index++; }
	if (!separator) { invalid(`Invalid line selector: ${token}`); return undefined; }
	if (token[index]?.toLowerCase() === "l") index++;
	const endNumber = readNumber(token, index);
	if (!endNumber) {
		if (separator === "+") invalid(`Invalid line selector :${token}; + requires a line count >= 1.`);
		return separator === "+" ? undefined : { start };
	}
	if (endNumber.end !== token.length) { invalid(`Invalid line selector: ${token}`); return undefined; }
	const parsed = endNumber.value;
	if (separator === "+") {
		if (parsed < 1) { invalid(`Invalid line selector :${token}; + count must be >= 1.`); return undefined; }
		return { start, end: start + parsed - 1 };
	}
	if (parsed < start) { invalid(`Invalid line selector :${token}; end must be >= start.`); return undefined; }
	return { start, end: parsed };
}
function isLineRangeListCandidate(value: string): boolean {
	if (!startsLikeLineRange(value)) return false;
	for (const char of value) {
		if (!isAsciiDigit(char) && char !== "L" && char !== "l" && char !== "+" && char !== "-" && char !== "." && char !== ",") return false;
	}
	return true;
}

function parseLineRangeList(value: string, invalid: (message: string) => void): ReadLineRange[] | undefined {
	if (!isLineRangeListCandidate(value)) return undefined;
	const ranges: ReadLineRange[] = [];
	for (const token of value.split(",")) {
		if (!token) { invalid(`Invalid line selector: ${value}`); return undefined; }
		const range = parseLineRangeToken(token, invalid);
		if (!range) return undefined;
		ranges.push(range);
	}
	return ranges;
}
function isBareLineNumber(value: string): boolean { return value.length > 0 && [...value].every(isAsciiDigit); }
function extractTrailingLineRange(value: string, invalid: (message: string) => void): { path: string; ranges: ReadLineRange[] } | undefined {
	const colonIndex = value.lastIndexOf(":");
	if (colonIndex < 0) return undefined;
	const rangeText = value.slice(colonIndex + 1);
	const ranges = parseLineRangeList(rangeText, invalid);
	if (!ranges) return undefined;
	const path = value.slice(0, colonIndex);
	// Support the `file:START:END` (and grep-style `file:LINE:COL`) colon
	// convention: a trailing bare-number segment preceded by another bare-number
	// segment reads as START..END. Without this the leading number stays glued to
	// the path (`file:395`) and produces a broken filename.
	const prevColon = path.lastIndexOf(":");
	if (prevColon >= 0 && ranges.length === 1 && ranges[0]!.end === undefined && isBareLineNumber(rangeText)) {
		const prevSegment = path.slice(prevColon + 1);
		if (isBareLineNumber(prevSegment)) {
			const start = Number.parseInt(prevSegment, 10);
			const end = ranges[0]!.start;
			if (start >= 1) return { path: path.slice(0, prevColon), ranges: [end >= start ? { start, end } : { start }] };
		}
	}
	return { path, ranges };
}
function selectorFromRanges(path: string, ranges: ReadLineRange[], raw: boolean, conflicts: boolean): ReadLineSelector {
	if (ranges.length === 1 && ranges[0]!.end === undefined) return { path, offset: ranges[0]!.start, raw, conflicts };
	return { path, ranges, raw, conflicts };
}
function parseArchiveReadSelector(value: string): ReadLineSelector {
	const state = { raw: false, conflicts: false };
	let working = peelArchiveReadSuffixes(value, state);
	const extracted = extractTrailingLineRange(working, () => undefined);
	if (!extracted) return { path: working, raw: state.raw, conflicts: state.conflicts };
	const suffixState = { ...state };
	const peeledPath = peelArchiveReadSuffixes(extracted.path, suffixState);
	const selectorPath = hasArchiveMember(peeledPath) ? (state.raw = suffixState.raw, state.conflicts = suffixState.conflicts, peeledPath) : extracted.path;
	if (!hasArchiveMember(selectorPath)) return { path: working, raw: state.raw, conflicts: state.conflicts };
	return selectorFromRanges(selectorPath, extracted.ranges, state.raw, state.conflicts);
}
function isHttpUrlWithPortOnly(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.port !== "" && url.pathname === "/" && url.search === "" && url.hash === "";
	} catch { return false; }
}

export function splitReadLineSelector(pathValue: string): ReadLineSelector {
	const state = { raw: false, conflicts: false };
	let value = pathValue;
	if (isArchiveSelectorPath(value)) return parseArchiveReadSelector(value);
	value = peelInlineReadSuffixes(value, state);
	if (isHttpUrlWithPortOnly(value)) return { path: value, raw: state.raw, conflicts: state.conflicts };
	let parseError: string | undefined;
	const extracted = extractTrailingLineRange(value, (message) => { parseError = message; });
	if (parseError) throw new Error(parseError);
	return extracted ? selectorFromRanges(extracted.path, extracted.ranges, state.raw, state.conflicts) : { path: value, raw: state.raw, conflicts: state.conflicts };
}

export function selectExactReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined): ReturnType<typeof selectReadRanges> {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [], lineNumbers: number[] = [], merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.start > allLines.length) continue;
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		const previous = merged.at(-1);
		if (previous && range.start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start: range.start, end });
	}
	for (const range of merged) for (let line = range.start; line <= (range.end ?? allLines.length); line++) { selectedLines.push(allLines[line - 1] ?? ""); lineNumbers.push(line); }
	return { selectedLines, selectedContent: selectedLines.join("\n"), firstLine: lineNumbers[0] ?? 1, lineNumbers, userLimitedLines: selectedLines.length };
}

export function selectReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined): { selectedLines: string[]; selectedContent: string; firstLine: number; lineNumbers?: number[]; userLimitedLines?: number } | undefined {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [];
	const lineNumbers: number[] = [];
	const merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const bounded = range.end !== undefined;
		if (range.start > allLines.length) continue;
		const requestedEnd = Math.min(range.end ?? allLines.length, allLines.length);
		if (requestedEnd < range.start) continue;
		const start = Math.max(1, range.start - (bounded ? 1 : 0));
		const end = Math.min(allLines.length, requestedEnd + (bounded ? 3 : 0));
		const previous = merged.at(-1);
		if (previous && start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start, end });
	}
	for (const range of merged) {
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		for (let line = range.start; line <= end; line++) {
			selectedLines.push(allLines[line - 1] ?? "");
			lineNumbers.push(line);
		}
	}
	return { selectedLines, selectedContent: selectedLines.join("\n"), firstLine: lineNumbers[0] ?? 1, lineNumbers, userLimitedLines: selectedLines.length };
}

export function formatHashlineSelectedLines(header: string, lines: string[], lineNumbers?: number[], startLine = 1): string {
	return [header, ...lines.map((line, index) => `${lineNumbers?.[index] ?? startLine + index}:${line}`)].join("\n");
}
