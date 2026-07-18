import type { LineRange, NumberedRegion, ValidatedRanges } from "./compaction-types.js";
import { FILTERED_MARKER_RE } from "./transcript-serialization.js";
import { VERBATIM_COMPACTION_PREFIX } from "../messages.js";
import { earliestProtectedSubsequenceAssignment, earliestSubsequenceAssignment } from "./subsequence-assignment.js";

/** Minimum number of source lines a valid compaction must delete. */
export const MIN_USEFUL_DELETED_LINES = 1;

export type SubsequenceRejectionReason =
	| "unmatched-line"
	| "dropped-protected-line"
	| "insufficient-deletion"
	| "empty-reproduction";

/** Thrown when a returned compacted string is not an acceptable subsequence. */
export class SubsequenceValidationError extends Error {
	readonly reason: SubsequenceRejectionReason;
	constructor(reason: SubsequenceRejectionReason, message: string) {
		super(message);
		this.name = "SubsequenceValidationError";
		this.reason = reason;
	}
}

/** Build ascending deletion ranges from the complement of the kept-line set. */
export function complementRanges(kept: ReadonlySet<number>, lineCount: number): LineRange[] {
	const ranges: LineRange[] = [];
	let start: number | undefined;
	for (let line = 1; line <= lineCount; line++) {
		if (!kept.has(line)) {
			if (start === undefined) start = line;
		} else if (start !== undefined) {
			ranges.push({ start, end: line - 1 });
			start = undefined;
		}
	}
	if (start !== undefined) ranges.push({ start, end: lineCount });
	return ranges;
}

function prepareOutputLines(output: string): string[] {
	let text = output;
	// The model may echo the boundary prefix; it is host framing, not source.
	if (text.startsWith(VERBATIM_COMPACTION_PREFIX)) text = text.slice(VERBATIM_COMPACTION_PREFIX.length);
	// Canonical `(filtered N lines)` markers are host-derived; a model-emitted
	// marker is advisory only and never trusted for line accounting.
	return text.split("\n").filter((line) => !FILTERED_MARKER_RE.test(line));
}

/**
 * Validate a model-returned compacted string as an ordered, byte-identical
 * subsequence of the region's source lines and convert it into the same
 * `ValidatedRanges` the mechanical reconstructor consumes.
 *
 * Rejections (contract §4):
 * - rewrite / reorder / hallucination / duplicated line → no forward
 *   byte-identical match under the monotonic pointer (`unmatched-line`);
 * - any protected line missing from the output (`dropped-protected-line`);
 * - fewer than `MIN_USEFUL_DELETED_LINES` deletions (`insufficient-deletion`);
 * - the model reproduced nothing (`empty-reproduction`).
 */
export function validateCompactedSubsequence(region: NumberedRegion, output: string): ValidatedRanges {
	const source = region.lines;
	const total = source.length;
	const outputLines = prepareOutputLines(output);

	if (!earliestSubsequenceAssignment(source, outputLines)) {
		throw new SubsequenceValidationError(
			"unmatched-line",
			"Compacted output contains a line that is not an in-order verbatim copy of the source (rewrite, reorder, duplication, or hallucination)",
		);
	}
	const protectedLines = region.protectedLineNumbers ?? new Set<number>();
	const assignment = earliestProtectedSubsequenceAssignment(source, outputLines, protectedLines);
	if (!assignment) {
		const firstProtected = [...protectedLines].sort((left, right) => left - right)[0];
		throw new SubsequenceValidationError(
			"dropped-protected-line",
			`Compacted output dropped protected line ${firstProtected}`,
		);
	}
	const kept = new Set(assignment);

	if (kept.size === 0) {
		throw new SubsequenceValidationError("empty-reproduction", "Compacted output reproduced no source lines");
	}

	const deleted = total - kept.size;
	if (deleted < MIN_USEFUL_DELETED_LINES) {
		throw new SubsequenceValidationError(
			"insufficient-deletion",
			"Compacted output deleted no useful source lines",
		);
	}

	return Object.assign(complementRanges(kept, total), { __brand: "ValidatedRanges" as const });
}
