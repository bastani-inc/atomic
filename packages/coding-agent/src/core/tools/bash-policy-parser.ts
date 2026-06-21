import type {
	BashCommandParseResult,
	BashCommandSegment,
	BashCommandSegmentSource,
	ShellQuoteState,
} from "./bash-policy-types.ts";
import { buildSegment } from "./bash-policy-segment.ts";
import {
	findClosingBacktick,
	findClosingParen,
	isCommandSubstitutionAt,
	isHereDocumentAt,
	isProcessSubstitutionAt,
	lineTerminatorLengthAt,
	operatorLengthAt,
} from "./bash-policy-shell.ts";

function shellError(reason: string, offset: number, source: BashCommandSegmentSource): BashCommandParseResult {
	return { ok: false, error: { reason, offset, source } };
}

function parseSegmentsInSource(
	input: string,
	baseOffset: number,
	source: BashCommandSegmentSource,
): BashCommandParseResult {
	const segments: BashCommandSegment[] = [];
	let quote: ShellQuoteState = "none";
	let segmentStart = 0;
	let nestedForCurrentSegment: BashCommandSegment[] = [];

	const commitSegment = (end: number): BashCommandParseResult | undefined => {
		const built = buildSegment(input.slice(segmentStart, end), baseOffset + segmentStart, baseOffset + end, source);
		if (!built.ok) return { ok: false, error: built.error };
		if (built.segment) segments.push(built.segment);
		segments.push(...nestedForCurrentSegment);
		nestedForCurrentSegment = [];
		return undefined;
	};

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i]!;

		if (quote === "single") {
			if (char === "'") quote = "none";
			continue;
		}

		if (char === "\\") {
			if (i + 1 >= input.length) {
				return shellError("trailing escape", baseOffset + i, source);
			}
			i += 1;
			continue;
		}

		if (quote === "double") {
			if (char === "\"") {
				quote = "none";
				continue;
			}
			if (isCommandSubstitutionAt(input, i)) {
				const close = findClosingParen(input, i + 1, "command substitution `$(`");
				if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
				const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "command-substitution");
				if (!nested.ok) return nested;
				nestedForCurrentSegment.push(...nested.segments);
				i = close.closeIndex;
				continue;
			}
			if (char === "`") {
				const close = findClosingBacktick(input, i);
				if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
				const nested = parseSegmentsInSource(input.slice(i + 1, close.closeIndex), baseOffset + i + 1, "backtick");
				if (!nested.ok) return nested;
				nestedForCurrentSegment.push(...nested.segments);
				i = close.closeIndex;
			}
			continue;
		}

		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === "\"") {
			quote = "double";
			continue;
		}
		if (isHereDocumentAt(input, i)) {
			return shellError("here-documents are not supported by bash policy segments mode", baseOffset + i, source);
		}
		if (isCommandSubstitutionAt(input, i)) {
			const close = findClosingParen(input, i + 1, "command substitution `$(`");
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "command-substitution");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (isProcessSubstitutionAt(input, i)) {
			const close = findClosingParen(input, i + 1, "process substitution");
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 2, close.closeIndex), baseOffset + i + 2, "process-substitution");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (char === "`") {
			const close = findClosingBacktick(input, i);
			if (!close.ok) return shellError(close.reason, baseOffset + close.offset, source);
			const nested = parseSegmentsInSource(input.slice(i + 1, close.closeIndex), baseOffset + i + 1, "backtick");
			if (!nested.ok) return nested;
			nestedForCurrentSegment.push(...nested.segments);
			i = close.closeIndex;
			continue;
		}
		if (char === "(" || char === ")") {
			return shellError("unsupported shell grouping parentheses", baseOffset + i, source);
		}

		const lineTerminatorLength = lineTerminatorLengthAt(input, i);
		if (lineTerminatorLength > 0) {
			const committed = commitSegment(i);
			if (committed) return committed;
			i += lineTerminatorLength - 1;
			segmentStart = i + 1;
			continue;
		}

		const operatorLength = operatorLengthAt(input, i);
		if (operatorLength > 0) {
			const committed = commitSegment(i);
			if (committed) return committed;
			i += operatorLength - 1;
			segmentStart = i + 1;
		}
	}

	if (quote === "single") return shellError("unclosed single quote", baseOffset + input.length, source);
	if (quote === "double") return shellError("unclosed double quote", baseOffset + input.length, source);
	const committed = commitSegment(input.length);
	if (committed) return committed;
	return { ok: true, segments };
}

export function parseBashCommandSegments(command: string): BashCommandParseResult {
	return parseSegmentsInSource(command, 0, "top-level");
}

export function wholeCommandTarget(command: string): BashCommandSegment {
	const target = command;
	const trimmed = command.trimStart();
	const leading = command.length - trimmed.length;
	const firstSpace = trimmed.search(/\s/);
	const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	return {
		raw: command,
		target,
		head,
		start: leading,
		end: command.length,
		source: "top-level",
	};
}
