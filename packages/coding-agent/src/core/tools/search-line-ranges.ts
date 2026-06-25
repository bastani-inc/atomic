export interface SearchLineRange {
	start: number;
	end: number;
}

export function parseLineRangeSpec(spec: string): SearchLineRange[] | undefined {
	const ranges: SearchLineRange[] = [];
	for (const part of spec.split(",")) {
		const plus = part.match(/^(\d+)\+(\d+)$/);
		const dash = part.match(/^(\d+)(?:-|\.\.)(\d+)$/);
		const single = part.match(/^(\d+)$/);
		let start = 0;
		let end = 0;
		if (plus) {
			start = Number.parseInt(plus[1] ?? "0", 10);
			const count = Number.parseInt(plus[2] ?? "0", 10);
			if (count < 1) return undefined;
			end = start + count - 1;
		} else if (dash) {
			start = Number.parseInt(dash[1] ?? "0", 10);
			end = Number.parseInt(dash[2] ?? "0", 10);
		} else if (single) {
			start = end = Number.parseInt(single[1] ?? "0", 10);
		} else return undefined;
		if (start < 1 || end < start) return undefined;
		ranges.push({ start, end });
	}
	return ranges.length > 0 ? ranges : undefined;
}

export function splitLineRangeSelector(value: string): { path: string; lineRanges?: SearchLineRange[] } {
	const match = value.match(/^(.*):(\d+(?:(?:-|\.\.|\+)\d*)?(?:,\d+(?:(?:-|\.\.|\+)\d*)?)*)$/);
	if (!match) return { path: value };
	const ranges = parseLineRangeSpec(match[2] ?? "");
	if (!ranges) throw new Error(`Invalid line-range selector: ${match[2] ?? ""}`);
	return { path: match[1] ?? value, lineRanges: ranges };
}

function rowLineNumber(line: string): { lineNumber: number; isMatch: boolean } | undefined {
	const match = line.match(/^.+?(?::(\d+): |-(\d+)- )/);
	if (!match) return undefined;
	return { lineNumber: Number.parseInt(match[1] ?? match[2] ?? "0", 10), isMatch: match[1] !== undefined };
}

export function filterSearchOutputByLineRange(text: string, ranges: readonly SearchLineRange[] | undefined, contextBefore = 1, contextAfter = 3): string {
	if (!ranges || ranges.length === 0) return text;
	const inSelectedRange = (lineNumber: number): boolean => ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
	const acceptedMatches: number[] = [];
	for (const line of text.split("\n")) {
		const row = rowLineNumber(line);
		if (row?.isMatch && inSelectedRange(row.lineNumber)) acceptedMatches.push(row.lineNumber);
	}
	if (acceptedMatches.length === 0) return "No matches found";
	const keepLine = (lineNumber: number): boolean => acceptedMatches.some((matchLine) => lineNumber >= matchLine - contextBefore && lineNumber <= matchLine + contextAfter);
	const filtered = text.split("\n").filter((line) => {
		const row = rowLineNumber(line);
		return row !== undefined && keepLine(row.lineNumber);
	}).join("\n");
	return filtered || "No matches found";
}
