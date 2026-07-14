import type { CompactedTranscript, LineRange, NumberedRegion } from "./compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";

interface Section {
	header: number | undefined;
	start: number;
	end: number;
}

function partitionSections(region: NumberedRegion): Section[] {
	const sections: Section[] = [];
	let current: Section | undefined;
	for (let line = 1; line <= region.lines.length; line++) {
		if (region.headerLineNumbers.has(line)) {
			if (current) {
				current.end = line - 1;
				sections.push(current);
			}
			current = { header: line, start: line, end: region.lines.length };
		} else if (!current) {
			current = { header: undefined, start: line, end: region.lines.length };
		}
	}
	if (current) sections.push(current);
	return sections;
}

function firstBodyLine(section: Section): number | undefined {
	const line = section.header === undefined ? section.start : section.header + 1;
	return line <= section.end ? line : undefined;
}

function reconstruct(region: NumberedRegion, ranges: LineRange[]): CompactedTranscript {
	return reconstructCompactedTranscript(region, validateDeletedRanges(ranges, region));
}

function failure(tokensAfter: number, budget: number): Error {
	return new Error(
		`Context deterministic overflow eviction failed: line eviction exhausted; achieved tokensAfter=${tokensAfter}; budget=${budget}; nothing more was safely deletable`,
	);
}

/**
 * Deterministically remove oldest section bodies while retaining every role header,
 * the first user objective line, and the final section's first line.
 */
export function evictLinesDeterministically(region: NumberedRegion, tokenBudget: number): CompactedTranscript {
	if (tokenBudget <= 0) throw failure(region.tokenEstimate, tokenBudget);
	let result = reconstruct(region, []);
	if (result.stats.tokensAfter <= tokenBudget) return result;

	const sections = partitionSections(region);
	const firstUserIndex = sections.findIndex(
		(section) => section.header !== undefined && region.lines[section.header - 1].startsWith("[User]: "),
	);
	const protectedLines = new Set<number>();
	for (const line of region.headerLineNumbers) protectedLines.add(line);
	if (firstUserIndex >= 0) {
		const objectiveLine = firstBodyLine(sections[firstUserIndex]);
		if (objectiveLine !== undefined) protectedLines.add(objectiveLine);
	}
	const finalFirstLine = firstBodyLine(sections[sections.length - 1]);
	if (finalFirstLine !== undefined) protectedLines.add(finalFirstLine);

	const ranges: LineRange[] = [];
	for (const section of sections) {
		let rangeStart: number | undefined;
		for (let line = section.header === undefined ? section.start : section.header + 1; line <= section.end; line++) {
			if (protectedLines.has(line)) {
				if (rangeStart !== undefined) ranges.push({ start: rangeStart, end: line - 1 });
				rangeStart = undefined;
			} else if (rangeStart === undefined) {
				rangeStart = line;
			}
		}
		if (rangeStart !== undefined) ranges.push({ start: rangeStart, end: section.end });
		result = reconstruct(region, ranges);
		if (result.stats.tokensAfter <= tokenBudget) return result;
	}

	throw failure(result.stats.tokensAfter, tokenBudget);
}
