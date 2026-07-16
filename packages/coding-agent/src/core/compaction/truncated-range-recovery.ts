/**
 * Deterministic line-based parser for compaction planner deletion records.
 *
 * Record grammar: `<uint>,<uint>\n` where each `<uint>` is a canonical unsigned
 * decimal integer (no sign, no decimals, no exponent, no leading zero except
 * the integer zero itself). Exactly one comma separates start and end.
 *
 * Normal completion: the final valid record may omit a trailing newline.
 * Length-truncated recovery: only complete newline-terminated records before
 * the final EOF fragment are accepted. A final non-newline-terminated record is
 * NEVER accepted on a length stop because EOF may have cut a multi-digit integer
 * (e.g. `300,30` could have intended `300,305`).
 *
 * Invalid syntax in any completed line (i.e. any line followed by a newline)
 * causes full rejection — records are never selectively skipped.
 */

import type { RawLineRange } from "./compaction-types.js";

/** Recovery result for diagnostics. */
export interface TruncatedRecoveryResult {
	ranges: RawLineRange[];
	/** Category for sidecar diagnostics. */
	category: "partial_length_recovery";
	/** Number of ranges recovered from the truncated response. */
	recoveredCount: number;
}

/**
 * Validate that a string is a canonical unsigned decimal integer.
 * - No sign prefix
 * - No leading zeros (except the integer `0` itself)
 * - At least one digit
 * - Only ASCII digits 0-9
 */
function isCanonicalUint(s: string): boolean {
	if (s.length === 0) return false;
	if (s.length > 1 && s[0] === "0") return false; // leading zero
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false; // not 0-9
	}
	return true;
}

/**
 * Parse a single record line. Returns the range or undefined if invalid.
 * The line must NOT contain a trailing newline.
 */
function parseRecord(line: string): RawLineRange | undefined {
	const commaIdx = line.indexOf(",");
	if (commaIdx < 0) return undefined;
	// Ensure exactly one comma
	if (line.indexOf(",", commaIdx + 1) >= 0) return undefined;
	const startStr = line.slice(0, commaIdx);
	const endStr = line.slice(commaIdx + 1);
	if (!isCanonicalUint(startStr) || !isCanonicalUint(endStr)) return undefined;
	return { start: Number(startStr), end: Number(endStr) };
}

/**
 * Parse the complete planner response into deletion ranges.
 * Returns undefined if the text contains zero valid records or any syntax error.
 *
 * For a normal (non-length) completion, the final record may omit a trailing newline.
 * Every record must pass strict grammar validation.
 */
export function parseRangeRecords(text: string): RawLineRange[] | undefined {
	if (text.length === 0) return undefined;
	// Split on newlines; if the text ends with \n the last element will be empty
	const lines = text.split("\n");
	const ranges: RawLineRange[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip trailing empty string from final newline
		if (i === lines.length - 1 && line === "") continue;
		const record = parseRecord(line);
		if (!record) return undefined; // invalid syntax → reject all
		ranges.push(record);
	}
	return ranges.length > 0 ? ranges : undefined;
}

/**
 * Recover complete newline-terminated records from a length-truncated response.
 *
 * Only lines that are followed by a newline (i.e. completed lines) are accepted.
 * The final fragment after the last newline is always discarded, even if it looks
 * syntactically valid, because EOF may have cut a multi-digit integer.
 *
 * Every completed line must be valid; invalid syntax in any completed line
 * causes full rejection (returns undefined).
 *
 * Returns undefined if zero usable records are recovered.
 */
export function recoverTruncatedRecords(text: string): TruncatedRecoveryResult | undefined {
	// Find the last newline — everything after it is the truncated fragment
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline < 0) return undefined; // no completed line at all

	const completedPortion = text.slice(0, lastNewline);
	if (completedPortion.length === 0) return undefined;

	const lines = completedPortion.split("\n");
	const ranges: RawLineRange[] = [];
	for (const line of lines) {
		if (line === "") return undefined; // blank line = invalid
		const record = parseRecord(line);
		if (!record) return undefined; // invalid syntax in completed line → reject all
		ranges.push(record);
	}

	if (ranges.length === 0) return undefined;
	return { ranges, category: "partial_length_recovery", recoveredCount: ranges.length };
}
