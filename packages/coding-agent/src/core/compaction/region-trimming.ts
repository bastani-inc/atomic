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

// Trimming continues while a strictly smaller view exists. `nextTrimOffset`
// halves the remaining suffix, so the walk is finite and logarithmic. RFC §5.3
// makes "overflowed with trimming exhausted" the terminal condition and
// authorizes no attempt cap.

function rebaseSet(source: ReadonlySet<number> | undefined, offset: number): Set<number> {
	const rebased = new Set<number>();
	for (const line of source ?? []) {
		if (line > offset) rebased.add(line - offset);
	}
	return rebased;
}

/**
 * Return the region as seen after withholding its oldest `offset` lines, or
 * `undefined` when that offset leaves nothing rankable.
 */
export function trimRegionHead(region: NumberedRegion, offset: number): NumberedRegion | undefined {
	if (offset <= 0 || offset >= region.lines.length) return undefined;
	const lines = region.lines.slice(offset);
	const priorMarkerNs = new Map<number, number>();
	for (const [line, count] of region.priorMarkerNs) {
		if (line > offset) priorMarkerNs.set(line - offset, count);
	}
	return {
		__brand: "NumberedRegion",
		lines,
		headerLineNumbers: rebaseSet(region.headerLineNumbers, offset),
		priorMarkerNs,
		...(region.protectedLineNumbers ? { protectedLineNumbers: rebaseSet(region.protectedLineNumbers, offset) } : {}),
		tokenEstimate: Math.ceil(lines.join("\n").length / 4),
	};
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
