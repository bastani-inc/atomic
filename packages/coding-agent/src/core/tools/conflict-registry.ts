import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join, relative } from "node:path";

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
	const lines = text.split("\n"),
		blocks: ConflictBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index]?.startsWith("<<<<<<<")) continue;
		let baseSep: number | undefined,
			sep = -1,
			end = -1;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			if (lines[cursor]?.startsWith("|||||||")) baseSep = cursor;
			else if (lines[cursor]?.startsWith("=======")) sep = cursor;
			else if (lines[cursor]?.startsWith(">>>>>>>")) {
				end = cursor;
				break;
			}
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

export async function findConflictBlocks(root: string, limit = 100): Promise<ConflictBlock[]> {
	const out: ConflictBlock[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await fsReaddir(dir, { withFileTypes: true }).catch(() => [])) {
			if (out.length >= limit || entry.name === ".git" || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) {
				const text = await fsReadFile(full, "utf8").catch(() => "");
				if (text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>"))
					out.push(...parseConflictBlocks(full, text));
			}
		}
	}
	await walk(root);
	return out;
}
/**
 * Reconcile the read-time conflict view (registry, populated by `read
 * …:conflicts`) against the live tree-walk snapshot. A registered block is
 * only trustworthy when the markers still sit at its recorded file+offset —
 * otherwise the file drifted and the id→block mapping would be wrong. When
 * any registered block is still live, resolve ids against the registered
 * ordering (what the agent actually saw); otherwise fall back to the fresh
 * tree walk. This closes the divergent id-space where `conflict://2` could
 * resolve a different block than the read displayed.
 */
export function reconcileConflictBlocks(live: ConflictBlock[], cwd: string): ConflictBlock[] {
	const registered = getRegisteredConflictBlocks(cwd);
	if (registered.length === 0) return live;
	const liveKeys = new Set(live.map((block) => `${block.file}\0${block.start}\0${block.end}`));
	const registeredLive = registered.filter((block) => liveKeys.has(`${block.file}\0${block.start}\0${block.end}`));
	// If the registered view no longer matches the live tree at all, the file
	// changed under us — trust the live walk rather than a stale id mapping.
	return registeredLive.length > 0 ? registeredLive : live;
}

const CONFLICT_SIDES = ["ours", "theirs", "base"] as const;
type ConflictSide = (typeof CONFLICT_SIDES)[number];

function conflictSection(side: ConflictSide, lines: readonly string[]): string[] {
	return [`## ${side}`, ...lines];
}

/**
 * Text for a `conflict://` read: `conflict://*` lists every conflict region under `cwd`, `conflict://<id>` shows one,
 * and `conflict://<id>/ours|theirs|base` returns that side's lines. The ids are the ones `write` resolves.
 */
export async function readConflictUrl(url: string, cwd: string): Promise<string> {
	const target = decodeURIComponent(url.slice("conflict://".length));
	if (!target)
		throw new Error(
			"conflict:// target is required: conflict://<id>, conflict://<id>/ours|theirs|base or conflict://*",
		);
	const [id = "", side, ...extra] = target.split("/");
	const live = await findConflictBlocks(cwd);
	if (live.length === 0) throw new Error("No conflict markers found.");
	const blocks = reconcileConflictBlocks(live, cwd);
	const describe = (block: ConflictBlock, index: number): string[] => [
		`# conflict://${index + 1} ${relative(cwd, block.file)}:${block.start + 1}-${block.end + 1}`,
		...conflictSection("ours", block.ours),
		...conflictSection("theirs", block.theirs),
		...(block.baseSep === undefined ? [] : conflictSection("base", block.base)),
	];
	if (id === "*") {
		if (side !== undefined) throw new Error("conflict://* does not take a side.");
		return blocks.flatMap(describe).join("\n");
	}
	if (!/^\d+$/.test(id)) throw new Error("Conflict reads must target conflict://<id> or conflict://*.");
	const block = blocks[Number.parseInt(id, 10) - 1];
	if (!block) throw new Error(`Conflict id not found: ${id}`);
	if (side === undefined) return describe(block, Number.parseInt(id, 10) - 1).join("\n");
	if (extra.length > 0 || !CONFLICT_SIDES.includes(side as ConflictSide))
		throw new Error(`Unknown conflict side: ${side}; use ours, theirs or base.`);
	return block[side as ConflictSide].join("\n");
}
