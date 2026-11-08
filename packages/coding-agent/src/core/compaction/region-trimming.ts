/**
 * Oldest-first planner-input trimming for context overflow.
 *
 * Port of codex's `history.remove_first_item()` retry on
 * `ContextWindowExceeded` (`compact.rs:309-343`). Codex can discard trimmed
 * history because it writes a summary; Atomic promises validated deletion
 * boundaries over the original numbered lines, so trimming here is a *view*
 * over the same region:
 *
 * - the planner is shown only lines `offset+1..N`, renumbered `1..N-offset`;
 * - protected spans and prior filtered markers are rebased into that view;
 * - the returned ranges are rebased back onto the original numbering;
 * - the withheld head becomes a deterministic deletion range, because the
 *   planner cannot rank what it was not shown and the oldest lines carry the
 *   lowest continuation value. Protected lines inside the head still survive:
 *   `validateDeletedRanges` splits every range around protected lines.
 */

import type { LineRange, NumberedRegion, RawLineRange } from "./compaction-types.js";
import { inferMessageSpans } from "./structured-compaction-input.js";

// Trimming continues while a strictly smaller view exists. `nextTrimOffset`
// halves the remaining suffix, so the walk is finite and logarithmic. RFC §5.3
// makes "overflowed with trimming exhausted" the terminal condition and
// authorizes no attempt cap.

function rebaseSet(source: ReadonlySet<number> | undefined, first: number, last: number): Set<number> {
	const rebased = new Set<number>();
	for (const line of source ?? []) {
		if (line >= first && line <= last) rebased.add(line - first + 1);
	}
	return rebased;
}

/**
 * The part of `region` covering lines `first..last`, renumbered from 1, with its message spans,
 * header lines, prior markers and protected lines rebased to match. Requires
 * `1 <= first <= last <= region.lines.length`.
 */
export function sliceRegion(region: NumberedRegion, first: number, last: number): NumberedRegion {
	const lines = region.lines.slice(first - 1, last);
	const priorMarkerNs = new Map<number, number>();
	for (const [line, count] of region.priorMarkerNs) {
		if (line >= first && line <= last) priorMarkerNs.set(line - first + 1, count);
	}
	return {
		__brand: "NumberedRegion",
		lines,
		...(region.messageSpans
			? {
					messageSpans: region.messageSpans
						.filter((span) => span.end >= first && span.start <= last)
						.map((span) => ({
							...span,
							start: Math.max(first, span.start) - first + 1,
							end: Math.min(last, span.end) - first + 1,
						})),
				}
			: {}),
		headerLineNumbers: rebaseSet(region.headerLineNumbers, first, last),
		priorMarkerNs,
		...(region.protectedLineNumbers
			? { protectedLineNumbers: rebaseSet(region.protectedLineNumbers, first, last) }
			: {}),
		tokenEstimate: Math.ceil(lines.join("\n").length / 4),
	};
}

/**
 * Return the region as seen after withholding its oldest `offset` lines, or
 * `undefined` when that offset leaves nothing rankable.
 */
export function trimRegionHead(region: NumberedRegion, offset: number): NumberedRegion | undefined {
	if (offset <= 0 || offset >= region.lines.length) return undefined;
	return sliceRegion(region, offset + 1, region.lines.length);
}

/**
 * How many lines the planner is asked to keep of `view`: the compression ratio's share, never fewer
 * than the protected lines, which count against the target rather than raising it.
 */
export function keepTargetForView(view: NumberedRegion, compressionRatio: number): number {
	return Math.max(view.protectedLineNumbers?.size ?? 0, Math.round(view.lines.length * compressionRatio));
}

/** One side of a message-boundary split, and the line of the whole region where it starts. */
export interface RegionPart {
	region: NumberedRegion;
	/** One-based line of the split region at which this part begins. */
	firstLine: number;
}

/**
 * Split `region` in two at the message boundary nearest its middle by characters, so neither part
 * cuts a message or a protected span. Characters, not lines, because a request's size is what a
 * refusal tracked (#4543). `undefined` when the region holds a single message.
 */
export function splitRegionAtMessageBoundary(region: NumberedRegion): [RegionPart, RegionPart] | undefined {
	const [, ...laterSpans] = region.messageSpans ?? inferMessageSpans(region);
	if (laterSpans.length === 0) return undefined;
	let totalChars = 0;
	const charsBeforeLine = region.lines.map((line) => {
		const before = totalChars;
		totalChars += line.length + 1;
		return before;
	});
	const imbalanceAt = (firstLineOfRightPart: number) =>
		Math.abs(2 * charsBeforeLine[firstLineOfRightPart - 1] - totalChars);
	const boundaryLine = laterSpans.reduce((nearest, span) =>
		imbalanceAt(span.start) < imbalanceAt(nearest.start) ? span : nearest,
	).start;
	return [
		{ region: sliceRegion(region, 1, boundaryLine - 1), firstLine: 1 },
		{ region: sliceRegion(region, boundaryLine, region.lines.length), firstLine: boundaryLine },
	];
}

/**
 * Next withheld-head size after an overflow, halving what remains each time, or
 * `undefined` when no further trimming is possible.
 */
export function nextTrimOffset(region: NumberedRegion, currentOffset: number): number | undefined {
	const remaining = region.lines.length - currentOffset;
	if (remaining <= 1) return undefined;
	const next = currentOffset + Math.max(1, Math.floor(remaining / 2));
	return next >= region.lines.length ? undefined : next;
}

/**
 * Map ranges validated against a trimmed view back onto the original region,
 * adding the withheld head as a deterministic deletion.
 */
export function rebaseTrimmedRanges(validated: readonly LineRange[], offset: number): RawLineRange[] {
	const rebased: RawLineRange[] = [{ start: 1, end: offset }];
	for (const range of validated) rebased.push({ start: range.start + offset, end: range.end + offset });
	return rebased;
}
