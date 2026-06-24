export interface ReadLineRange { start: number; end?: number }

export interface ReadLineSelector {
	path: string;
	offset?: number;
	limit?: number;
	ranges?: ReadLineRange[];
	raw?: boolean;
	conflicts?: boolean;
}

export function isReadResourceSelector(pathValue: string): boolean {
	return /^[^:]+\.(zip|jar|tar|tgz|gz|sqlite|db):/i.test(pathValue) || /^[a-z]+:\/\//i.test(pathValue) || pathValue.startsWith("skill://");
}
function isArchiveSelectorPath(value: string): boolean { return /^.+\.(?:zip|jar|tar|tgz|tar\.gz|gz):/i.test(value); }
function peelArchiveReadSuffixes(value: string, state: { raw: boolean; conflicts: boolean }): string {
	let working = value;
	for (;;) {
		const next = working.match(/^(.*):(raw|conflicts)$/);
		if (!next) return working;
		state.raw ||= next[2] === "raw";
		state.conflicts ||= next[2] === "conflicts";
		working = next[1] ?? working;
	}
}
function parseArchiveReadSelector(value: string): ReadLineSelector {
	const state = { raw: false, conflicts: false };
	let working = peelArchiveReadSuffixes(value, state);
	const match = working.match(/^(.*):L?(\d+(?:(?:-|\.\.|\+)L?\d*)?(?:,L?\d+(?:(?:-|\.\.|\+)L?\d*)?)*)$/);
	if (!match) return { path: working, raw: state.raw, conflicts: state.conflicts };
	const beforeRange = match[1] ?? working;
	const suffixState = { ...state };
	const peeledPath = peelArchiveReadSuffixes(beforeRange, suffixState);
	const selectorPath = /^.+\.(?:zip|jar|tar|tgz|tar\.gz|gz):.+$/i.test(peeledPath) ? (state.raw = suffixState.raw, state.conflicts = suffixState.conflicts, peeledPath) : beforeRange;
	const member = selectorPath.match(/^.+\.(?:zip|jar|tar|tgz|tar\.gz|gz):(.*)$/i)?.[1];
	if (!member) return { path: working, raw: state.raw, conflicts: state.conflicts };
	const ranges: ReadLineRange[] = [];
	for (const range of (match[2] ?? "").split(",")) {
		const part = range.match(/^L?(\d+)(?:(-|\.\.|\+)L?(\d*))?$/);
		if (!part) return { path: working, raw: state.raw, conflicts: state.conflicts };
		const start = Number.parseInt(part[1] ?? "0", 10);
		if (start < 1) return { path: working, raw: state.raw, conflicts: state.conflicts };
		const sep = part[2], rawEnd = part[3];
		if (!sep || (rawEnd === "" && sep !== "+")) { ranges.push({ start }); continue; }
		if (rawEnd === "") return { path: working, raw: state.raw, conflicts: state.conflicts };
		const parsed = Number.parseInt(rawEnd ?? "0", 10);
		if (sep === "+") { if (parsed < 1) return { path: working, raw: state.raw, conflicts: state.conflicts }; ranges.push({ start, end: start + parsed - 1 }); }
		else { if (parsed < start) return { path: working, raw: state.raw, conflicts: state.conflicts }; ranges.push({ start, end: parsed }); }
	}
	if (ranges.length === 1 && ranges[0]!.end === undefined) return { path: selectorPath, offset: ranges[0]!.start, raw: state.raw, conflicts: state.conflicts };
	return { path: selectorPath, ranges, raw: state.raw, conflicts: state.conflicts };
}



export function splitReadLineSelector(pathValue: string): ReadLineSelector {
	let value = pathValue;
	let raw = false;
	let conflicts = false;
	if (isArchiveSelectorPath(value)) return parseArchiveReadSelector(value);
	for (;;) {
		const next = value.replace(/:raw(?=(:|$))/, () => { raw = true; return ""; }).replace(/:conflicts(?=(:|$))/, () => { conflicts = true; return ""; });
		if (next === value) break;
		value = next;
	}
	if (/^https?:\/\/[^/:]+:\d+$/i.test(value)) return { path: value, raw, conflicts };
	const match = value.match(/^(.*):L?(\d+(?:(?:-|\.\.|\+)L?\d*)?(?:,L?\d+(?:(?:-|\.\.|\+)L?\d*)?)*)$/);
	if (!match) return { path: value, raw, conflicts };
	const selectorPath = match[1] ?? value;
	const ranges: ReadLineRange[] = [];
	for (const range of (match[2] ?? "").split(",")) {
		const part = range.match(/^L?(\d+)(?:(-|\.\.|\+)L?(\d*))?$/);
		if (!part) throw new Error(`Invalid line selector: ${range}`);
		const start = Number.parseInt(part[1] ?? "0", 10);
		if (start < 1) throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
		const sep = part[2];
		const rawEnd = part[3];
		if (!sep || (rawEnd === "" && sep !== "+")) { ranges.push({ start }); continue; }
		if (rawEnd === "") throw new Error(`Invalid line selector :${range}; + requires a line count >= 1.`);
		const parsed = Number.parseInt(rawEnd ?? "0", 10);
		if (sep === "+") {
			if (parsed < 1) throw new Error(`Invalid line selector :${range}; + count must be >= 1.`);
			ranges.push({ start, end: start + parsed - 1 });
		} else {
			if (parsed < start) throw new Error(`Invalid line selector :${range}; end must be >= start.`);
			ranges.push({ start, end: parsed });
		}
	}
	if (ranges.length === 1) {
		const [range] = ranges;
		if (range!.end === undefined) return { path: selectorPath, offset: range!.start, raw, conflicts };
	}
	return { path: selectorPath, ranges, raw, conflicts };
}

export function selectExactReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined): ReturnType<typeof selectReadRanges> {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [], lineNumbers: number[] = [], merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.start > allLines.length) continue;
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		const previous = merged.at(-1);
		if (previous && range.start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start: range.start, end });
	}
	for (const range of merged) for (let line = range.start; line <= (range.end ?? allLines.length); line++) { selectedLines.push(allLines[line - 1] ?? ""); lineNumbers.push(line); }
	return { selectedLines, selectedContent: selectedLines.join("\n"), firstLine: lineNumbers[0] ?? 1, lineNumbers, userLimitedLines: selectedLines.length };
}

export function selectReadRanges(allLines: string[], ranges: ReadLineRange[] | undefined): { selectedLines: string[]; selectedContent: string; firstLine: number; lineNumbers?: number[]; userLimitedLines?: number } | undefined {
	if (!ranges || ranges.length === 0) return undefined;
	const selectedLines: string[] = [];
	const lineNumbers: number[] = [];
	const merged: ReadLineRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const bounded = range.end !== undefined;
		if (range.start > allLines.length) continue;
		const requestedEnd = Math.min(range.end ?? allLines.length, allLines.length);
		if (requestedEnd < range.start) continue;
		const start = Math.max(1, range.start - (bounded ? 1 : 0));
		const end = Math.min(allLines.length, requestedEnd + (bounded ? 3 : 0));
		const previous = merged.at(-1);
		if (previous && start <= (previous.end ?? 0) + 1) previous.end = Math.max(previous.end ?? 0, end);
		else merged.push({ start, end });
	}
	for (const range of merged) {
		const end = Math.min(range.end ?? allLines.length, allLines.length);
		for (let line = range.start; line <= end; line++) {
			selectedLines.push(allLines[line - 1] ?? "");
			lineNumbers.push(line);
		}
	}
	return { selectedLines, selectedContent: selectedLines.join("\n"), firstLine: lineNumbers[0] ?? 1, lineNumbers, userLimitedLines: selectedLines.length };
}

export function formatHashlineSelectedLines(header: string, lines: string[], lineNumbers?: number[], startLine = 1): string {
	return [header, ...lines.map((line, index) => `${lineNumbers?.[index] ?? startLine + index}:${line}`)].join("\n");
}
