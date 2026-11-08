import type { CompactedTranscript, LineRange, NumberedRegion } from "./compaction-types.js";
import { keepContextMarker, ROLE_HEADER_RE } from "./transcript-serialization.js";
import { contiguousRanges } from "./utils.ts";

/**
 * Fraction of the hard input limit kept free when protected spans are dropped. The region estimate
 * is four characters per token and leaves out the system prompt, tool definitions and the recall
 * hint, so landing exactly on the limit would overflow again.
 */
export const PROTECTED_DROP_SAFETY_MARGIN_RATIO = 0.1;

const QUOTE_MAX_CHARACTERS = 48;
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Protected spans the fresh rung removed because the protected content alone could not fit. */
export interface DroppedProtectedSpans {
	/** Number of protected spans removed. */
	count: number;
	/** Total number of protected region lines removed. */
	lines: number;
	/** The removed spans as one-based inclusive line ranges of the compactable region, oldest first. */
	ranges: LineRange[];
}

/** The notice shown to the user when protected blocks had to be removed to fit the context window. */
export function droppedProtectedWarning(dropped: DroppedProtectedSpans): string {
	const blocks = `${dropped.count} protected ${dropped.count === 1 ? "block" : "blocks"}`;
	const lines = `${dropped.lines} ${dropped.lines === 1 ? "line" : "lines"}`;
	return `Compaction removed ${blocks} (${lines}) to fit the context window. They remain in this session's history; each marker in the compacted context says how to recall its block.`;
}

export interface ProtectedDropMarkerInput {
	lineCount: number;
	/** Short text from the removed block, used to find it again with `search`. */
	quote: string;
	sessionId?: string;
	/** History line range of the block, when known. */
	historyRange?: LineRange;
}

export interface ProtectedOverflowFit {
	transcript: CompactedTranscript;
	dropped: DroppedProtectedSpans;
}

export interface ProtectedOverflowRequest {
	region: NumberedRegion;
	/** The fresh transcript: every unprotected line already deleted. */
	fresh: CompactedTranscript;
	hardInputLimit: number;
	/** Estimated tokens of the kept tail that is sent along with the transcript; zero when dropped. */
	keptTailTokens: number;
	sessionId?: string;
}

function lineTokens(characters: number): number {
	return Math.ceil(characters / 4);
}

function escapeForSearch(text: string): string {
	return text.replace(REGEX_METACHARACTERS, "\\$&");
}

function quoteLine(line: string): string {
	return line.replace(ROLE_HEADER_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Short text identifying a protected block in history. A `<keepContext>` block opens with a bare
 * tag line that history search would match in every block, so the quote comes from the first line
 * that is not a tag. A block made only of tags falls back to its first non-blank line.
 */
export function protectedSpanQuote(lines: readonly string[]): string {
	const content = lines.find((line) => quoteLine(line) !== "" && keepContextMarker(line) === undefined);
	const chosen = content ?? lines.find((line) => quoteLine(line) !== "");
	if (chosen === undefined) return "";
	return Array.from(quoteLine(chosen)).slice(0, QUOTE_MAX_CHARACTERS).join("");
}

export function protectedDropMarker(input: ProtectedDropMarkerInput): string {
	const noun = input.lineCount === 1 ? "line" : "lines";
	const source = input.sessionId === undefined ? "this session's history" : `history://sessions/${input.sessionId}`;
	const find = input.quote === "" ? `search ${source}` : `search on ${source} for "${escapeForSearch(input.quote)}"`;
	const open =
		input.historyRange === undefined
			? "then read the match with :N-M"
			: `or read ${source}:${input.historyRange.start}-${input.historyRange.end}`;
	return `[protected block removed to fit the context window: ${input.lineCount} ${noun}; recall with ${find}, ${open}]`;
}

function lineCharacters(lines: readonly string[], range: LineRange): number {
	let characters = 0;
	for (let line = range.start; line <= range.end; line++) characters += lines[line - 1].length + 1;
	return characters;
}

function spanLength(range: LineRange): number {
	return range.end - range.start + 1;
}

function spanLines(region: NumberedRegion, range: LineRange): string[] {
	return region.lines.slice(range.start - 1, range.end);
}

function sameRange(left: LineRange, right: LineRange): boolean {
	return left.start === right.start && left.end === right.end;
}

function rebuildWithoutSpans(
	request: ProtectedOverflowRequest,
	dropped: readonly LineRange[],
	markers: ReadonlyMap<LineRange, string>,
): string {
	const { region, fresh } = request;
	const freshLines = fresh.text.split("\n");
	const segments = [
		...fresh.ranges.map((range) => ({ range, kind: "filtered" as const })),
		...contiguousRanges(region.protectedLineNumbers ?? new Set<number>()).map((range) => ({
			range,
			kind: "protected" as const,
		})),
	].sort((left, right) => left.range.start - right.range.start);

	const output: string[] = [];
	let line = 1;
	let textIndex = 0;
	const passThrough = (count: number): void => {
		for (let step = 0; step < count; step++) output.push(freshLines[textIndex++]);
	};
	for (const { range, kind } of segments) {
		passThrough(range.start - line);
		if (kind === "filtered") {
			passThrough(1);
		} else {
			const droppedSpan = dropped.find((candidate) => sameRange(candidate, range));
			if (droppedSpan) {
				output.push(markers.get(droppedSpan) ?? "");
				textIndex += spanLength(range);
			} else {
				passThrough(spanLength(range));
			}
		}
		line = range.end + 1;
	}
	passThrough(region.lines.length + 1 - line);
	return output.join("\n");
}

/**
 * Last resort for a fresh context window whose protected spans alone exceed the hard input limit.
 *
 * Only called once every unprotected compactable line is already gone, so nothing cheaper is left
 * to remove. Spans are dropped whole, oldest first, and only as many as needed to bring the
 * rebuilt context within the limit less a safety margin; each becomes a one-line recall marker.
 * Returns undefined when the context already fits or dropping cannot help.
 */
export function dropProtectedSpansToFit(request: ProtectedOverflowRequest): ProtectedOverflowFit | undefined {
	const { region, fresh, hardInputLimit, keptTailTokens } = request;
	if (!Number.isFinite(hardInputLimit) || hardInputLimit <= 0) return undefined;
	const rebuiltTokens = (characters: number): number => lineTokens(characters) + keptTailTokens;
	if (rebuiltTokens(fresh.text.length) <= hardInputLimit) return undefined;

	const target = hardInputLimit - Math.ceil(hardInputLimit * PROTECTED_DROP_SAFETY_MARGIN_RATIO);
	const spans = contiguousRanges(region.protectedLineNumbers ?? new Set<number>());
	const dropped: LineRange[] = [];
	const markers = new Map<LineRange, string>();
	let characters = fresh.text.length;
	for (const span of spans) {
		if (rebuiltTokens(characters) <= target) break;
		const marker = protectedDropMarker({
			lineCount: spanLength(span),
			quote: protectedSpanQuote(spanLines(region, span)),
			...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
		});
		const saved = lineCharacters(region.lines, span) - (marker.length + 1);
		if (saved <= 0) continue;
		dropped.push(span);
		markers.set(span, marker);
		characters -= saved;
	}
	if (dropped.length === 0) return undefined;

	const text = rebuildWithoutSpans(request, dropped, markers);
	const droppedLines = dropped.reduce((total, span) => total + spanLength(span), 0);
	const ranges = [...fresh.ranges, ...dropped].sort((left, right) => left.start - right.start);
	const linesDeleted = fresh.stats.linesDeleted + droppedLines;
	const tokensAfter = lineTokens(text.length);
	return {
		transcript: {
			text,
			ranges,
			keptRanges: fresh.keptRanges.filter((kept) => !dropped.some((span) => sameRange(span, kept))),
			stats: {
				...fresh.stats,
				linesDeleted,
				linesKept: region.lines.length - linesDeleted,
				rangeCount: ranges.length,
				tokensAfter,
				percentReduction:
					region.tokenEstimate === 0 ? 0 : Math.round((1 - tokensAfter / region.tokenEstimate) * 1000) / 10,
			},
		},
		dropped: { count: dropped.length, lines: droppedLines, ranges: dropped },
	};
}
