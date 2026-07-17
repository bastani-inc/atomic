import type { NumberedRegion, VerbatimCompactionParameters } from "./compaction-types.js";

const EDGE_CANDIDATES = 4;

function protectedRanges(lines: ReadonlySet<number>): string {
	const sorted = [...lines].sort((left, right) => left - right);
	if (sorted.length === 0) return "none";
	const ranges: string[] = [];
	let start = sorted[0];
	let end = start;
	for (const line of sorted.slice(1)) {
		if (line === end + 1) end = line;
		else { ranges.push(start === end ? `${start}` : `${start}-${end}`); start = line; end = line; }
	}
	ranges.push(start === end ? `${start}` : `${start}-${end}`);
	return ranges.join(", ");
}

/**
 * Request-local projection retaining every protected source line and stable edge
 * candidates with their original one-based numbers. Durable source is untouched.
 */
export function buildElidedCollapsePlannerPrompt(
	region: NumberedRegion,
	parameters: VerbatimCompactionParameters,
	targetKeepLines: number,
): string | undefined {
	const protectedLines = region.protectedLineNumbers ?? new Set<number>();
	const eligible = region.lines.map((_, index) => index + 1).filter((line) => !protectedLines.has(line));
	const candidates = new Set<number>([
		...eligible.slice(0, EDGE_CANDIDATES),
		...eligible.slice(-EDGE_CANDIDATES),
		...protectedLines,
	]);
	if (candidates.size >= region.lines.length) return undefined;
	const visible = [...candidates].sort((left, right) => left - right)
		.map((line) => `${line}→${region.lines[line - 1]}`)
		.join("\n");
	const omitted = region.lines.length - candidates.size;
	return `<compaction-transcript projection="isolated-elided">
${visible}
<omitted-unprotected-lines count="${omitted}" />
</compaction-transcript>

The numbered source lines keep their ORIGINAL line numbers. The omitted-range marker is an instruction, not source: never echo it. Reproduce only byte-identical CONTENT from visible source lines, in original order, deleting low-value lines. Never rewrite, renumber, summarize, merge, add, or echo markers.

Original total physical lines: ${region.lines.length}
Target lines to keep: ${targetKeepLines}
Relevance focus: ${parameters.query}
Protected original line ranges (all mandatory): ${protectedRanges(protectedLines)}

Keep protected lines plus the most useful visible candidates. Output retained source CONTENT only and nothing else.`;
}
