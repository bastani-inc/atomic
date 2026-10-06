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

function inferMessageSpans(region: NumberedRegion): NonNullable<NumberedRegion["messageSpans"]> {
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

export function parseMessageRangeRecords(text: string, truncated = false): MessageLineRange[] | undefined {
	const complete = truncated
		? text.slice(0, Math.max(0, text.lastIndexOf("\n")))
		: text.endsWith("\n")
			? text.slice(0, -1)
			: text;
	if (!complete) return undefined;
	const ranges: MessageLineRange[] = [];
	for (const line of complete.split("\n")) {
		const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(line);
		if (!match) return undefined;
		const [id, start, end] = match.slice(1).map(Number);
		if (![id, start, end].every(Number.isSafeInteger)) return undefined;
		ranges.push({ id, start, end });
	}
	return ranges;
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
