import type { LineRange, NumberedRegion, VerbatimCompactionParameters } from "./compaction-types.js";
import { ROLE_HEADER_RE } from "./transcript-serialization.js";
import { contiguousRanges } from "./utils.ts";

export interface CompactionInputMessage {
	id: number;
	role: "user" | "assistant" | "tool";
	lines: string[];
}

export interface MessageLineRange extends LineRange {
	id: number;
}

export interface StructuredCompactionInput {
	messages: CompactionInputMessage[];
	query: string;
	compression_ratio: number;
	protected: MessageLineRange[];
}

export function buildStructuredCompactionInput(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
): StructuredCompactionInput {
	const spans = region.messageSpans ?? inferMessageSpans(region);
	const messages = spans.map((span, index) => ({
		id: index + 1,
		role: span.role,
		lines: region.lines.slice(span.start - 1, span.end),
	}));
	const protectedRanges = spans.flatMap((span, index) =>
		contiguousRanges(
			new Set(
				[...(region.protectedLineNumbers ?? [])]
					.filter((line) => line >= span.start && line <= span.end)
					.map((line) => line - span.start + 1),
			),
		).map((range) => ({ id: index + 1, ...range })),
	);
	return {
		messages,
		query: parameters.query,
		compression_ratio: parameters.compression_ratio,
		protected: protectedRanges,
	};
}

export function inferMessageSpans(region: NumberedRegion): NonNullable<NumberedRegion["messageSpans"]> {
	const spans: NonNullable<NumberedRegion["messageSpans"]> = [];
	for (let index = 0; index < region.lines.length; index++) {
		const header = ROLE_HEADER_RE.exec(region.lines[index]);
		if (header || spans.length === 0) {
			if (spans.length > 0) spans[spans.length - 1].end = index;
			spans.push({
				role: header?.[1] === "User" ? "user" : header?.[1] === "Tool result" ? "tool" : "assistant",
				start: index + 1,
				end: region.lines.length,
			});
		}
	}
	return spans;
}

const MESSAGE_RANGE_RECORD_RE = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/;

/**
 * A planner answer is malformed when more than this fraction of its non-blank,
 * non-fence lines are not records. Exactly this fraction is still accepted.
 */
export const MAX_SKIPPED_LINE_FRACTION = 0.5;

export interface ParsedMessageRangeRecords {
	/** Valid records in the order the planner emitted them. */
	ranges: MessageLineRange[];
	/** Non-blank, non-fence lines that were not valid records. */
	skippedLineCount: number;
}

/**
 * Parse planner output into `id:start,end` records, skipping lines that are not records.
 * Blank lines and Markdown fence lines are ignored without being counted. Returns
 * undefined when no record remains or when skipped lines exceed `MAX_SKIPPED_LINE_FRACTION`.
 * With `truncated`, the incomplete last line is dropped before parsing.
 */
export function parseMessageRangeRecords(text: string, truncated = false): ParsedMessageRangeRecords | undefined {
	const complete = truncated ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text;
	const ranges: MessageLineRange[] = [];
	let skippedLineCount = 0;
	for (const rawLine of complete.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("```")) continue;
		const match = MESSAGE_RANGE_RECORD_RE.exec(line);
		const [id, start, end] = match ? match.slice(1).map(Number) : [];
		if (match && [id, start, end].every(Number.isSafeInteger)) ranges.push({ id, start, end });
		else skippedLineCount++;
	}
	if (ranges.length === 0) return undefined;
	if (skippedLineCount > MAX_SKIPPED_LINE_FRACTION * (ranges.length + skippedLineCount)) return undefined;
	return { ranges, skippedLineCount };
}

export function mapMessageRanges(ranges: readonly MessageLineRange[], input: StructuredCompactionInput): LineRange[] {
	const offsets = new Map<number, { offset: number; length: number }>();
	let offset = 0;
	for (const message of input.messages) {
		offsets.set(message.id, { offset, length: message.lines.length });
		offset += message.lines.length;
	}
	return ranges.flatMap((range) => {
		const message = offsets.get(range.id);
		if (!message || range.start < 1 || range.end < range.start || range.end > message.length) return [];
		return [{ start: message.offset + range.start, end: message.offset + range.end }];
	});
}
