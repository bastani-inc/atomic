const FORK_TASK_MARKER = "\n\nTask:\n";
const PROGRESS_TRAILER_PREFIX = "\n\n---\n";
const PROGRESS_TRAILER_LABELS = [
	"Create and maintain progress at:",
	"Update progress at:",
	"Write your findings to:",
] as const;
const WRITE_TO_PREFIX_LOWER = "[write to:";

/** Exact JavaScript `\s` membership for a UTF-16 code unit. */
export function isJsWhitespace(code: number): boolean {
	return (
		code === 0x20 ||
		(code >= 0x09 && code <= 0x0d) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

/** Exact JavaScript `[^\S\n]` membership for a UTF-16 code unit. */
export function isHorizontalJsWhitespace(code: number): boolean {
	return code !== 0x0a && isJsWhitespace(code);
}

/** Advances past zero or more lines containing only horizontal JS whitespace before each newline. */
export function skipHorizontalWhitespaceLines(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		let linePos = i;
		while (linePos < text.length && isHorizontalJsWhitespace(text.charCodeAt(linePos))) {
			linePos++;
		}
		if (linePos < text.length && text.charCodeAt(linePos) === 0x0a) {
			i = linePos + 1;
		} else {
			break;
		}
	}
	return i;
}

/** ASCII case-insensitive match without allocating or shifting UTF-16 indices (matching JS non-`/u` `/i`). */
export function matchesAsciiCaseInsensitiveAt(text: string, lowerNeedle: string, offset: number): boolean {
	if (offset < 0 || offset + lowerNeedle.length > text.length) return false;
	for (let i = 0; i < lowerNeedle.length; i++) {
		let code = text.charCodeAt(offset + i);
		if (code >= 0x41 && code <= 0x5a) code += 32;
		if (code !== lowerNeedle.charCodeAt(i)) return false;
	}
	return true;
}

/** Finds the leftmost ASCII case-insensitive occurrence of a non-empty lowercase ASCII needle at or after `fromIndex`. */
export function findAsciiCaseInsensitive(text: string, lowerNeedle: string, fromIndex: number): number {
	const limit = text.length - lowerNeedle.length;
	if (fromIndex > limit) return -1;
	const firstLower = lowerNeedle.charCodeAt(0);
	const isAsciiLetter = firstLower >= 0x61 && firstLower <= 0x7a;
	if (!isAsciiLetter) {
		const firstChar = lowerNeedle[0]!;
		let pos = fromIndex;
		while (pos <= limit) {
			const idx = text.indexOf(firstChar, pos);
			if (idx === -1 || idx > limit) return -1;
			if (matchesAsciiCaseInsensitiveAt(text, lowerNeedle, idx)) return idx;
			pos = idx + 1;
		}
		return -1;
	}
	const firstUpper = firstLower - 32;
	for (let pos = fromIndex; pos <= limit; pos++) {
		const code = text.charCodeAt(pos);
		if ((code === firstLower || code === firstUpper) && matchesAsciiCaseInsensitiveAt(text, lowerNeedle, pos)) {
			return pos;
		}
	}
	return -1;
}

function isAllHorizontalWhitespace(text: string, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		if (!isHorizontalJsWhitespace(text.charCodeAt(i))) return false;
	}
	return true;
}

function matchProgressTrailerLabel(text: string, lineStart: number, lineEnd: number): number {
	const lineLen = lineEnd - lineStart;
	for (const label of PROGRESS_TRAILER_LABELS) {
		if (lineLen >= label.length && text.startsWith(label, lineStart)) {
			return label.length;
		}
	}
	return -1;
}

function stripTrailingProgressTrailer(text: string): string {
	if (text.length === 0 || text.charCodeAt(text.length - 1) === 0x0a) return text;
	const prefixLen = PROGRESS_TRAILER_PREFIX.length;
	const lastNl = text.lastIndexOf("\n");
	const lastLineStart = lastNl + 1;
	// Case 1: label is on the final line (zero blank lines after the label), with at least one char after it.
	if (lastLineStart >= prefixLen && text.startsWith(PROGRESS_TRAILER_PREFIX, lastLineStart - prefixLen)) {
		const labelLen = matchProgressTrailerLabel(text, lastLineStart, text.length);
		if (labelLen !== -1 && lastLineStart + labelLen < text.length) {
			return text.slice(0, lastLineStart - prefixLen);
		}
	}
	// Case 2: one or more blank horizontal-whitespace lines separate the label line from the final line.
	let lineEnd = lastNl;
	while (lineEnd >= 0) {
		const prevNl = lineEnd > 0 ? text.lastIndexOf("\n", lineEnd - 1) : -1;
		const lineStart = prevNl + 1;
		if (isAllHorizontalWhitespace(text, lineStart, lineEnd)) {
			lineEnd = prevNl;
			continue;
		}
		if (lineStart >= prefixLen && text.startsWith(PROGRESS_TRAILER_PREFIX, lineStart - prefixLen)) {
			const labelLen = matchProgressTrailerLabel(text, lineStart, lineEnd);
			if (labelLen !== -1 && isAllHorizontalWhitespace(text, lineStart + labelLen, lineEnd)) {
				return text.slice(0, lineStart - prefixLen);
			}
		}
		break;
	}
	return text;
}

function stripTrailingWriteToTrailer(text: string): string {
	let end = text.length;
	while (end > 0 && isJsWhitespace(text.charCodeAt(end - 1))) {
		end--;
	}
	if (end === 0 || text.charCodeAt(end - 1) !== 0x5d) return text;
	const closeIdx = end - 1;
	let k = closeIdx - 1;
	while (k >= 0) {
		const code = text.charCodeAt(k);
		if (code === 0x0a) break;
		if (code === 0x5d) return text;
		k--;
	}
	const prevNl = k;
	const lineStart = prevNl + 1;
	if (lineStart === closeIdx) return text;

	// Check an earlier `\n\n[Write to:` separated by blank lines first so the leftmost match wins.
	let lineEnd = prevNl;
	while (lineEnd >= 0) {
		const earlierNl = lineEnd > 0 ? text.lastIndexOf("\n", lineEnd - 1) : -1;
		const earlierStart = earlierNl + 1;
		if (isAllHorizontalWhitespace(text, earlierStart, lineEnd)) {
			lineEnd = earlierNl;
			continue;
		}
		if (
			earlierStart >= 2 &&
			text.charCodeAt(earlierStart - 2) === 0x0a &&
			text.charCodeAt(earlierStart - 1) === 0x0a &&
			matchesAsciiCaseInsensitiveAt(text, WRITE_TO_PREFIX_LOWER, earlierStart) &&
			isAllHorizontalWhitespace(text, earlierStart + WRITE_TO_PREFIX_LOWER.length, lineEnd)
		) {
			return text.slice(0, earlierStart - 2);
		}
		break;
	}

	if (
		lineStart >= 2 &&
		text.charCodeAt(lineStart - 2) === 0x0a &&
		text.charCodeAt(lineStart - 1) === 0x0a &&
		matchesAsciiCaseInsensitiveAt(text, WRITE_TO_PREFIX_LOWER, lineStart) &&
		lineStart + WRITE_TO_PREFIX_LOWER.length < closeIdx
	) {
		return text.slice(0, lineStart - 2);
	}
	return text;
}

export function unwrapSubagentPrompt(task: string): string {
	let text = task;
	const forkIndex = text.indexOf(FORK_TASK_MARKER);
	if (forkIndex >= 0 && text.startsWith("You are continuing from")) {
		text = text.slice(forkIndex + FORK_TASK_MARKER.length);
	}
	text = stripTrailingProgressTrailer(text);
	text = stripTrailingWriteToTrailer(text);
	return text.trim();
}
