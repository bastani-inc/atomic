import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join, sep as pathSep, relative } from "node:path";
import ignore from "ignore";

export interface ConflictBlock {
	file: string;
	start: number;
	sep: number;
	end: number;
	baseSep?: number;
	ours: string[];
	theirs: string[];
	base: string[];
	/** Every line of the region as it was read, markers included. */
	lines: string[];
}

/** A conflict id's block, and whether the file no longer holds it as it was read. */
export interface ConflictEntry {
	block: ConflictBlock;
	stale: boolean;
}

const conflictRegistry = new Map<string, ConflictBlock[]>();

/** Most conflict regions a tree walk collects, and most files it opens, so a huge tree stays cheap. */
const MAX_CONFLICT_BLOCKS = 100;
const MAX_SCANNED_FILES = 10_000;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

type ConflictMarker = "<" | "|" | "=" | ">";

/**
 * The marker a line is, as Git writes it: exactly seven marker characters at the start of the line, then the end of
 * the line or a space and a label. `========`, `=======foo` and `>>>>>>>>` are content.
 */
function conflictMarker(line: string): ConflictMarker | undefined {
	return /^(?:<{7}|\|{7}|={7}|>{7})(?:[ \r]|$)/.test(line) ? (line[0] as ConflictMarker) : undefined;
}

/**
 * Conflict regions in `text`. A region is `<<<<<<<`, an optional `|||||||` base, `=======`, then `>>>>>>>`; a marker
 * line anywhere else in the region (a second separator, a base after the separator, an end before it, or a nested
 * start) makes the region ambiguous, so it is left out rather than split at a guess, as Git's rerere refuses it.
 */
export function parseConflictBlocks(file: string, text: string): ConflictBlock[] {
	const lines = text.split("\n"),
		blocks: ConflictBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (conflictMarker(lines[index] ?? "") !== "<") continue;
		let baseSep: number | undefined,
			sep = -1,
			end = -1;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			const marker = conflictMarker(lines[cursor] ?? "");
			if (marker === undefined) continue;
			if (marker === "|" && sep < 0 && baseSep === undefined) baseSep = cursor;
			else if (marker === "=" && sep < 0) sep = cursor;
			else if (marker === ">" && sep >= 0) end = cursor;
			if (end >= 0 || (cursor !== baseSep && cursor !== sep)) break;
		}
		if (end < 0) continue;
		blocks.push({
			file,
			start: index,
			sep,
			end,
			baseSep,
			ours: lines.slice(index + 1, baseSep ?? sep),
			base: baseSep === undefined ? [] : lines.slice(baseSep + 1, sep),
			theirs: lines.slice(sep + 1, end),
			lines: lines.slice(index, end + 1),
		});
		index = end;
	}
	return blocks;
}

/**
 * Conflict regions in a file's bytes. Bytes that are not UTF-8 decode to U+FFFD here, which never changes where a
 * line starts; writes check the region's own bytes before touching the file.
 */
export function parseConflictBytes(file: string, bytes: Buffer): ConflictBlock[] {
	return parseConflictBlocks(file, bytes.toString("utf8"));
}

async function readConflictFile(file: string): Promise<ConflictBlock[]> {
	return parseConflictBytes(file, await fsReadFile(file));
}

/**
 * Record the conflict regions a read of `file` showed. Regions of other files read earlier keep their ids; the
 * file's earlier regions are replaced where they stood.
 */
export function registerConflictBlocks(cwd: string, file: string, blocks: ConflictBlock[]): void {
	const registered = conflictRegistry.get(cwd) ?? [];
	const at = registered.findIndex((block) => block.file === file);
	const others = registered.filter((block) => block.file !== file);
	others.splice(at < 0 ? others.length : at, 0, ...blocks);
	conflictRegistry.set(cwd, others);
}

/** Re-read `file` and record its current conflict regions, after a write changed it. */
export async function refreshConflictFile(cwd: string, file: string): Promise<void> {
	if (!conflictRegistry.get(cwd)?.some((block) => block.file === file)) return;
	registerConflictBlocks(cwd, file, await readConflictFile(file));
}

function sameBlock(a: ConflictBlock, b: ConflictBlock): boolean {
	return a.file === b.file && a.start === b.start && a.lines.join("\n") === b.lines.join("\n");
}

type IgnoreMatcher = ReturnType<typeof ignore>;

/** The `.gitignore`/`.ignore` rules in `dir`, rooted at `root` like Git's nested ignore files. */
async function addIgnoreRules(matcher: IgnoreMatcher, dir: string, root: string): Promise<void> {
	const prefix = relative(root, dir).split(pathSep).join("/");
	for (const name of IGNORE_FILE_NAMES) {
		const text = await fsReadFile(join(dir, name), "utf8").catch(() => "");
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const negated = line.startsWith("!");
			const pattern = negated ? line.slice(1) : line;
			const anchored = pattern.replace(/^\//, "");
			// A pattern without an inner slash matches at any depth below its directory; `/x` is `x` at the root.
			const scoped =
				pattern.startsWith("/") || anchored.replace(/\/$/, "").includes("/")
					? `${prefix}/${anchored}`
					: `${prefix}/**/${anchored}`;
			matcher.add(negated ? `!${scoped}` : scoped);
		}
	}
}

/**
 * Every conflict region under `root`, in walk order. Like `search`, the walk skips `.git`, `node_modules` and paths
 * the `.gitignore`/`.ignore` files ignore, and stops after `limit` regions or `MAX_SCANNED_FILES` files.
 */
export async function findConflictBlocks(root: string, limit = MAX_CONFLICT_BLOCKS): Promise<ConflictBlock[]> {
	const out: ConflictBlock[] = [];
	const matcher = ignore();
	let scanned = 0;
	async function walk(dir: string): Promise<void> {
		await addIgnoreRules(matcher, dir, root);
		const entries = await fsReaddir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (out.length >= limit || scanned >= MAX_SCANNED_FILES) return;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			const rel = relative(root, full).split(pathSep).join("/");
			if (entry.isDirectory()) {
				if (!matcher.ignores(`${rel}/`)) await walk(full);
			} else if (entry.isFile() && !matcher.ignores(rel)) {
				scanned++;
				const bytes = await fsReadFile(full).catch(() => undefined);
				if (bytes?.includes("<<<<<<<") && bytes.includes("=======") && bytes.includes(">>>>>>>"))
					out.push(...parseConflictBytes(full, bytes).slice(0, limit - out.length));
			}
		}
	}
	await walk(root);
	return out;
}

/**
 * The conflict ids under `cwd`. Ids start with the regions `read …:conflicts` showed, in read order, so an id names
 * what the agent saw; a region whose markers, separator or sides changed since that read keeps its id but is stale,
 * and is never resolved. Every other region under `cwd` follows, in walk order.
 */
export async function conflictEntries(cwd: string): Promise<ConflictEntry[]> {
	const registered = conflictRegistry.get(cwd) ?? [];
	const current = new Map<string, ConflictBlock[]>();
	for (const file of new Set(registered.map((block) => block.file)))
		current.set(file, await readConflictFile(file).catch(() => []));
	const entries = registered.map((block) => ({
		block,
		stale: !(current.get(block.file) ?? []).some((live) => sameBlock(live, block)),
	}));
	for (const block of await findConflictBlocks(cwd))
		if (!registered.some((seen) => sameBlock(seen, block))) entries.push({ block, stale: false });
	return entries;
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
	if (id !== "*" && !/^\d+$/.test(id)) throw new Error("Conflict reads must target conflict://<id> or conflict://*.");
	if (id === "*" && side !== undefined) throw new Error("conflict://* does not take a side.");
	const entries = await conflictEntries(cwd);
	const index = Number(id) - 1;
	if (entries[index]?.stale)
		throw new Error(`Conflict ${id} changed since it was read; read conflict://* or the file again.`);
	if (!entries.some((candidate) => !candidate.stale)) throw new Error("No conflict markers found.");
	const describe = (block: ConflictBlock, at: number): string[] => [
		`# conflict://${at + 1} ${relative(cwd, block.file)}:${block.start + 1}-${block.end + 1}`,
		...conflictSection("ours", block.ours),
		...conflictSection("theirs", block.theirs),
		...(block.baseSep === undefined ? [] : conflictSection("base", block.base)),
	];
	if (id === "*")
		return entries.flatMap((candidate, at) => (candidate.stale ? [] : describe(candidate.block, at))).join("\n");
	const entry = entries[index];
	if (!entry) throw new Error(`Conflict id not found: ${id}`);
	if (side === undefined) return describe(entry.block, index).join("\n");
	if (extra.length > 0 || !CONFLICT_SIDES.includes(side as ConflictSide))
		throw new Error(`Unknown conflict side: ${side}; use ours, theirs or base.`);
	return entry.block[side as ConflictSide].join("\n");
}
