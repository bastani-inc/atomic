export interface ConflictBlock {
	file: string;
	start: number;
	sep: number;
	end: number;
	baseSep?: number;
	ours: string[];
	theirs: string[];
	base: string[];
}

const conflictRegistry = new Map<string, ConflictBlock[]>();

export function parseConflictBlocks(file: string, text: string): ConflictBlock[] {
	const lines = text.split("\n"), blocks: ConflictBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index]?.startsWith("<<<<<<<")) continue;
		let baseSep: number | undefined, sep = -1, end = -1;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			if (lines[cursor]?.startsWith("|||||||")) baseSep = cursor;
			else if (lines[cursor]?.startsWith("=======")) sep = cursor;
			else if (lines[cursor]?.startsWith(">>>>>>>")) { end = cursor; break; }
		}
		if (sep < 0 || end < 0) continue;
		blocks.push({
			file,
			start: index,
			sep,
			end,
			baseSep,
			ours: lines.slice(index + 1, baseSep ?? sep),
			base: baseSep === undefined ? [] : lines.slice(baseSep + 1, sep),
			theirs: lines.slice(sep + 1, end),
		});
		index = end;
	}
	return blocks;
}

export function registerConflictBlocks(cwd: string, blocks: ConflictBlock[]): void {
	conflictRegistry.set(cwd, blocks);
}

/** All conflict blocks a prior `read …:conflicts` registered for this cwd, in read order. */
export function getRegisteredConflictBlocks(cwd: string): ConflictBlock[] {
	return conflictRegistry.get(cwd) ?? [];
}

export function getRegisteredConflictBlock(cwd: string, id: number): ConflictBlock | undefined {
	return conflictRegistry.get(cwd)?.[id - 1];
}
