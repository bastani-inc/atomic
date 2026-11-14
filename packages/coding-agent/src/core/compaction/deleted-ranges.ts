import type {
	CompactedTranscript,
	LineRange,
	NumberedRegion,
	RawLineEndpoint,
	RawLineRange,
	ValidatedRanges,
} from "./compaction-types.js";
import { filteredMarker } from "./transcript-serialization.js";
import { contiguousRanges } from "./utils.ts";

function coerceEndpoint(value: RawLineEndpoint | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
	const merged: LineRange[] = [];
	for (const range of ranges) {
		const current = merged[merged.length - 1];
		if (current && range.start <= current.end + 1) current.end = Math.max(current.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function splitAroundProtected(range: LineRange, protectedLines: ReadonlySet<number>): LineRange[] {
	const fragments: LineRange[] = [];
	let start = range.start;
	for (let line = range.start; line <= range.end; line++) {
		if (!protectedLines.has(line)) continue;
		if (start < line) fragments.push({ start, end: line - 1 });
		start = line + 1;
	}
	if (start <= range.end) fragments.push({ start, end: range.end });
	return fragments;
}

/** Extra share of the region the planner may delete beyond the keep target before records stop applying. */
export const KEEP_TARGET_TOLERANCE_RATIO = 0.05;

/** Unprotected lines a plan may delete: the target delete count plus the named tolerance, at least one for a non-empty region. */
export function deleteBudget(totalLines: number, targetKeepLines: number): number {
	return Math.max(0, totalLines - targetKeepLines) + Math.ceil(totalLines * KEEP_TARGET_TOLERANCE_RATIO);
}

export interface ValidateDeletedRangesOptions {
	/**
	 * Apply records in emitted order and stop once this many unprotected lines are
	 * deleted, clipping the record that crosses the limit to its leading new lines.
	 * Omitted, every record applies.
	 */
	maxDeletedLines?: number;
}

function normalizeRanges(raw: RawLineRange[], totalLines: number): LineRange[] {
	const normalized: LineRange[] = [];
	for (const candidate of raw) {
		let start = coerceEndpoint(candidate.start);
		let end = coerceEndpoint(candidate.end);
		if (start === undefined || end === undefined) continue;
		if (start > end) [start, end] = [end, start];
		start = Math.max(1, start);
		end = Math.min(totalLines, end);
		if (start <= end) normalized.push({ start, end });
	}
	return normalized;
}

function capInEmittedOrder(
	records: readonly LineRange[],
	protectedLines: ReadonlySet<number>,
	totalLines: number,
	maxDeletedLines: number,
): LineRange[] {
	const taken = new Uint8Array(totalLines + 1);
	const accepted: LineRange[] = [];
	let remaining = Math.max(0, Math.trunc(maxDeletedLines));
	for (const record of records) {
		let runStart: number | undefined;
		for (let line = record.start; line <= record.end + 1 && remaining > 0; line++) {
			const available = line <= record.end && !taken[line] && !protectedLines.has(line);
			if (available) {
				taken[line] = 1;
				remaining--;
				runStart ??= line;
			}
			if ((!available || remaining === 0) && runStart !== undefined) {
				accepted.push({ start: runStart, end: available ? line : line - 1 });
				runStart = undefined;
			}
		}
		if (remaining === 0) break;
	}
	return accepted;
}

/**
 * Normalize untrusted model ranges into the sole range type accepted by reconstruction.
 * The output is sorted and merged; `maxDeletedLines` limits it by emitted (priority) order first.
 */
export function validateDeletedRanges(
	raw: RawLineRange[],
	region: NumberedRegion,
	options: ValidateDeletedRangesOptions = {},
): ValidatedRanges {
	const totalLines = region.lines.length;
	const protectedLines = new Set(region.protectedLineNumbers ?? []);
	const normalized = normalizeRanges(raw, totalLines);
	const selected =
		options.maxDeletedLines === undefined
			? normalized
			: capInEmittedOrder(normalized, protectedLines, totalLines, options.maxDeletedLines);
	selected.sort((left, right) => left.start - right.start || left.end - right.end);
	const split = mergeRanges(selected).flatMap((range) => splitAroundProtected(range, protectedLines));
	return Object.assign(split, { __brand: "ValidatedRanges" as const });
}

function rangesToDeletedLines(ranges: ValidatedRanges, lineCount: number): boolean[] {
	const deleted = Array.from({ length: lineCount }, () => false);
	for (const range of ranges) {
		for (let line = range.start; line <= range.end; line++) deleted[line - 1] = true;
	}
	return deleted;
}

function foldAdjacentMarkers(region: NumberedRegion, ranges: ValidatedRanges): LineRange[] {
	const deleted = rangesToDeletedLines(ranges, region.lines.length);
	let changed = true;
	while (changed) {
		changed = false;
		for (const lineNumber of region.priorMarkerNs.keys()) {
			const index = lineNumber - 1;
			if (deleted[index]) continue;
			const previousDeleted = index > 0 ? (deleted[index - 1] ?? false) : false;
			const nextDeleted = index + 1 < deleted.length ? (deleted[index + 1] ?? false) : false;
			if (previousDeleted || nextDeleted) {
				deleted[index] = true;
				changed = true;
			}
		}
	}

	const folded: LineRange[] = [];
	let start: number | undefined;
	for (let index = 0; index <= deleted.length; index++) {
		// Sentinel iteration at index === deleted.length: treat as not deleted so a
		// trailing open range closes without reading past the array bounds.
		const isDeleted = index < deleted.length ? (deleted[index] ?? false) : false;
		if (isDeleted && start === undefined) start = index + 1;
		if (!isDeleted && start !== undefined) {
			folded.push({ start, end: index });
			start = undefined;
		}
	}
	return folded;
}

function cumulativeDeletedCount(region: NumberedRegion, range: LineRange): number {
	let count = range.end - range.start + 1;
	for (let line = range.start; line <= range.end; line++) {
		const priorCount = region.priorMarkerNs.get(line);
		if (priorCount !== undefined) count += priorCount - 1;
	}
	return count;
}

/** Rebuild a compacted transcript mechanically from validated ranges. */
export function reconstructCompactedTranscript(region: NumberedRegion, ranges: ValidatedRanges): CompactedTranscript {
	const finalRanges = foldAdjacentMarkers(region, ranges);
	const output: string[] = [];
	let line = 1;
	for (const range of finalRanges) {
		while (line < range.start) output.push(region.lines[line++ - 1]);
		output.push(filteredMarker(cumulativeDeletedCount(region, range)));
		line = range.end + 1;
	}
	while (line <= region.lines.length) output.push(region.lines[line++ - 1]);

	const text = output.join("\n");
	const linesDeleted = finalRanges.reduce((total, range) => total + range.end - range.start + 1, 0);
	const tokensAfter = Math.ceil(text.length / 4);
	const percentReduction =
		region.tokenEstimate === 0 ? 0 : Math.round((1 - tokensAfter / region.tokenEstimate) * 1000) / 10;
	return {
		text,
		ranges: finalRanges,
		keptRanges: contiguousRanges(region.protectedLineNumbers ?? new Set<number>()),
		releasedRanges: (region.releasedRanges ?? []).map((range) => ({ ...range })),
		stats: {
			linesBefore: region.lines.length,
			linesDeleted,
			linesKept: region.lines.length - linesDeleted,
			rangeCount: finalRanges.length,
			tokensBefore: region.tokenEstimate,
			tokensAfter,
			percentReduction,
		},
	};
}
