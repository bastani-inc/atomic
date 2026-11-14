import type { NumberedRegion, ReleasedRange } from "./compaction-types.js";
import {
	type KeepContextSpan,
	keepContextSpanKey,
	keepContextSpans,
	ROLE_HEADER_RE,
} from "./transcript-serialization.js";

/** Default share of the keep target that `<keepContext>` protection may fill before spans are released. */
export const DEFAULT_KEEP_CONTEXT_SHARE = 0.5;

/** The most recent spans in a region are released only after every older span. */
export const KEEP_CONTEXT_RECENT_SPANS = 3;

/** Use a share in `[0, 1]`; anything else falls back to the default. */
export function normalizeKeepContextShare(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: DEFAULT_KEEP_CONTEXT_SHARE;
}

/** One-based line of the region's last `[User]: ` header, or undefined when it has none. */
function latestUserHeaderLine(lines: readonly string[]): number | undefined {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (ROLE_HEADER_RE.exec(lines[index])?.[1] === "User") return index + 1;
	}
	return undefined;
}

/** Characters a line occupies in the region's text, its newline included. */
function lineChars(lines: readonly string[], lineNumber: number): number {
	return lines[lineNumber - 1].length + 1;
}

/**
 * Release whole `<keepContext>` spans until protection fits its budget.
 *
 * The budget is `share` of the keep target, applied to both lines and characters: protected lines
 * may fill at most `share × keepTarget` lines and `share × keepTarget / lines` of the region's text.
 * Protection is therefore never larger than the compacted context could be without any tags, so
 * tags change which lines survive, never whether compaction fits.
 *
 * While protection fits, the region is returned unchanged. Otherwise spans are released in this
 * order until it fits: older copies of a span repeated later (compared after whitespace
 * normalization), then the oldest spans, then the {@link KEEP_CONTEXT_RECENT_SPANS} most recent
 * spans, then spans in the region's latest user message. A released span becomes ordinary content
 * for the planner to rank; this step never unprotects part of one.
 *
 * `maxProtectedChars` tightens the character budget further, for a caller that must fit a model
 * window. Spans released by an earlier call stay released and keep their reported reason.
 */
export function releaseKeepContextSpans(
	region: NumberedRegion,
	keepTarget: number,
	share: number,
	maxProtectedChars = Number.POSITIVE_INFINITY,
): NumberedRegion {
	const { lines } = region;
	const protectedLines = new Set(region.protectedLineNumbers ?? []);
	const lineBudget = Math.floor(keepTarget * share);
	const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
	const charBudget = Math.min(
		maxProtectedChars,
		lines.length === 0 ? 0 : Math.floor((totalChars * keepTarget * share) / lines.length),
	);
	let protectedChars = 0;
	for (const line of protectedLines) protectedChars += lineChars(lines, line);
	const fits = (): boolean => protectedLines.size <= lineBudget && protectedChars <= charBudget;
	if (fits()) return region;

	// A span an earlier call released is no longer protected and is not released again.
	const spans = keepContextSpans(lines).filter((span) => protectedLines.has(span.start));
	const latestUser = latestUserHeaderLine(lines);
	const firstRecent = spans.length - KEEP_CONTEXT_RECENT_SPANS;
	/** 0: older spans, 1: the most recent spans, 2: spans in the latest user message. */
	const tier = (span: KeepContextSpan, index: number): number =>
		latestUser !== undefined && span.messageHeaderLine === latestUser ? 2 : index >= firstRecent ? 1 : 0;

	const released: ReleasedRange[] = [...(region.releasedRanges ?? [])];
	const release = (span: KeepContextSpan, reason: ReleasedRange["reason"]): void => {
		for (let line = span.start; line <= span.end; line++) {
			if (protectedLines.delete(line)) protectedChars -= lineChars(lines, line);
		}
		released.push({ start: span.start, end: span.end, reason });
	};

	const newerKeys = new Set<string>();
	const remaining: { span: KeepContextSpan; tier: number }[] = [];
	for (let index = spans.length - 1; index >= 0; index--) {
		const span = spans[index];
		const key = keepContextSpanKey(lines, span);
		if (newerKeys.has(key)) release(span, "duplicate");
		else remaining.unshift({ span, tier: tier(span, index) });
		newerKeys.add(key);
	}
	for (let current = 0; current <= 2; current++) {
		for (const candidate of remaining) {
			if (fits()) break;
			if (candidate.tier === current) release(candidate.span, "budget");
		}
	}

	if (released.length === (region.releasedRanges?.length ?? 0)) return region;
	released.sort((left, right) => left.start - right.start);
	return {
		...region,
		protectedLineNumbers: protectedLines.size > 0 ? protectedLines : undefined,
		releasedRanges: released,
	};
}
