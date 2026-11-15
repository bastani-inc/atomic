import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ToolDefinition } from "../extensions/types.ts";
import { type ConflictBlock, conflictEntries, refreshConflictFile } from "./conflict-registry.ts";
import { WriteSelectorError } from "./file-tool-errors.ts";
import {
	type InternalResourceContext,
	isInternalUrl,
	isUrlLike,
	parseArchiveSelector,
	parseSqliteSelector,
	resolveArchiveSelector,
	resolveInternalSelector,
	sqliteSelectorForPath,
	writeArchiveSelector,
	writeInternalSelector,
	writeSqliteSelector,
} from "./resource-selectors.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import type { createWriteToolDefinition } from "./write.ts";

type WriteToolDefinition = ReturnType<typeof createWriteToolDefinition>;
type WriteSchema = WriteToolDefinition["parameters"];

/** Where a selector write landed. Plain file writes carry no details. */
export interface WriteSelectorDetails {
	resolvedPath?: string;
	meta?: { sourcePath?: string };
}

type WriteSelectorResult = {
	content: Array<{ type: "text"; text: string }>;
	details: WriteSelectorDetails | undefined;
};

const NEWLINE = 0x0a;

/** A file's lines as bytes, split at `\n`; a line keeps its `\r`, so joining them with `\n` gives the bytes back. */
function splitByteLines(bytes: Buffer): Buffer[] {
	const lines: Buffer[] = [];
	let from = 0;
	for (let at = bytes.indexOf(NEWLINE); at >= 0; at = bytes.indexOf(NEWLINE, from)) {
		lines.push(bytes.subarray(from, at));
		from = at + 1;
	}
	lines.push(bytes.subarray(from));
	return lines;
}

/**
 * The bytes that replace a region. `@ours`, `@theirs` and `@base` keep that side's bytes. Other content is written
 * as UTF-8 with the region's line ending: CRLF when its start marker ends in CRLF, so a CRLF file (or a CRLF region
 * of a mixed file) stays CRLF; the last line ends as the end marker did.
 */
function conflictReplacement(content: string, block: ConflictBlock, region: Buffer[]): Buffer[] {
	const token = content.trim();
	const side = (from: number, to: number) => region.slice(from - block.start, to - block.start);
	if (token === "@ours") return side(block.start + 1, block.baseSep ?? block.sep);
	if (token === "@theirs") return side(block.sep + 1, block.end);
	if (token === "@base") return block.baseSep === undefined ? [] : side(block.baseSep + 1, block.sep);
	const unified = content.replace(/\r\n/g, "\n");
	const normalized = unified.endsWith("\n") ? unified.slice(0, -1) : unified;
	if (normalized === "") return [];
	const crlf = block.lines[0]?.endsWith("\r") === true;
	const lastEnding = block.lines.at(-1)?.endsWith("\r") === true ? "\r" : "";
	const lines = normalized.split("\n");
	return lines.map((line, index) =>
		Buffer.from(`${line}${index === lines.length - 1 ? lastEnding : crlf ? "\r" : ""}`, "utf8"),
	);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Splice each region's replacement into its file's bytes, leaving every other byte as it was. Every region is checked
 * before any file is written: its bytes must be UTF-8 and still read exactly as when it was listed.
 */
async function resolveConflictBlocks(
	blocks: ConflictBlock[],
	content: string,
	path: string,
	cwd: string,
): Promise<void> {
	const byFile = new Map<string, ConflictBlock[]>();
	for (const block of blocks) byFile.set(block.file, [...(byFile.get(block.file) ?? []), block]);
	const updates: Array<{ file: string; bytes: Buffer }> = [];
	for (const [file, fileBlocks] of byFile) {
		const lines = splitByteLines(await fsReadFile(file));
		for (const block of fileBlocks.sort((a, b) => b.start - a.start)) {
			const region = lines.slice(block.start, block.end + 1);
			let text: string[];
			try {
				text = region.map((line) => utf8.decode(line));
			} catch (error: unknown) {
				throw new WriteSelectorError(
					"conflict-not-utf8",
					`Conflict in ${file} is not valid UTF-8 text, and resolving it would corrupt its bytes. The file was left unchanged.`,
					{ path },
					{ cause: error },
				);
			}
			if (text.join("\n") !== block.lines.join("\n"))
				throw new WriteSelectorError(
					"conflict-stale",
					`Conflict in ${file} changed since it was read. No file was changed.`,
					{ path },
				);
			lines.splice(block.start, region.length, ...conflictReplacement(content, block, region));
		}
		updates.push({
			file,
			bytes: Buffer.concat(lines.flatMap((line, index) => (index ? [Buffer.of(NEWLINE), line] : [line]))),
		});
	}
	for (const { file, bytes } of updates) {
		await fsWriteFile(file, bytes);
		invalidateNativeSearchCache(file);
		await refreshConflictFile(cwd, file);
	}
}

function hasSqliteQueryParameters(path: string): boolean {
	return !!parseSqliteSelector(path)?.table && path.includes("?");
}

async function writeConflictSelector(path: string, content: string, cwd: string): Promise<WriteSelectorResult> {
	const target = decodeURIComponent(path.slice("conflict://".length));
	if (!target) throw new WriteSelectorError("conflict-target-required", "conflict:// target is required.", { path });
	if (target.includes("/"))
		throw new WriteSelectorError(
			"conflict-side-read-only",
			"Scoped conflict resources are read-only; write conflict://<id> or conflict://*.",
			{ path },
		);
	const entries = await conflictEntries(cwd);
	const entry = /^\d+$/.test(target) ? entries[Number.parseInt(target, 10) - 1] : undefined;
	if (entry?.stale)
		throw new WriteSelectorError(
			"conflict-stale",
			`Conflict ${target} changed since it was read. No file was changed.`,
			{ path, conflictId: target },
		);
	const blocks = entries.filter((candidate) => !candidate.stale).map((candidate) => candidate.block);
	if (blocks.length === 0)
		throw new WriteSelectorError("conflict-markers-not-found", "No conflict markers found.", { path });
	if (target === "*") {
		await resolveConflictBlocks(blocks, content, path, cwd);
		const text = `Resolved ${blocks.length} conflict${blocks.length === 1 ? "" : "s"}`;
		return { content: [{ type: "text", text }], details: undefined };
	}
	if (!/^\d+$/.test(target))
		throw new WriteSelectorError(
			"conflict-target-invalid",
			"Conflict writes must target conflict://<id> or conflict://*.",
			{ path, conflictId: target },
		);
	if (!entry)
		throw new WriteSelectorError("conflict-id-not-found", `Conflict id not found: ${target}`, {
			path,
			conflictId: target,
		});
	await resolveConflictBlocks([entry.block], content, path, cwd);
	return { content: [{ type: "text", text: `Resolved conflict ${target}` }], details: undefined };
}

/**
 * Atomic's `write` on top of pi's: archive members, SQLite rows, `conflict://` resolutions and internal URLs are
 * written here, and `local://` resolves to its file before pi's write runs. Every other path goes to `definition`
 * unchanged.
 */
export function withWriteSelectors(
	definition: WriteToolDefinition,
	cwd: string,
): ToolDefinition<WriteSchema, WriteSelectorDetails | undefined> {
	return {
		...definition,
		description: `${definition.description} The path may also be an archive member, a SQLite table or row selector, a merge-conflict resolution (conflict://<id> or conflict://*), or a writable internal resource such as local://.`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path, content } = params;
			const executionCwd = ctx?.cwd || cwd;
			if (hasSqliteQueryParameters(path))
				throw new WriteSelectorError(
					"sqlite-query-parameters",
					"SQLite write selectors must not include query parameters.",
					{ path },
				);
			const sqlite = sqliteSelectorForPath(path, executionCwd);
			if (!sqlite && parseSqliteSelector(path)?.table)
				throw new WriteSelectorError("sqlite-not-found", `SQLite database not found or is not SQLite: ${path}`, {
					path,
				});
			if (sqlite)
				return {
					content: [{ type: "text", text: writeSqliteSelector(sqlite, content) }],
					details: { meta: { sourcePath: sqlite.databasePath } },
				};
			const archive = parseArchiveSelector(path);
			if (archive) {
				const resolvedArchive = resolveArchiveSelector(archive, executionCwd);
				writeArchiveSelector(resolvedArchive, content);
				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					details: { resolvedPath: resolvedArchive.archivePath },
				};
			}
			if (path.startsWith("conflict://")) return writeConflictSelector(path, content, executionCwd);
			if (isUrlLike(path) && !isInternalUrl(path))
				throw new WriteSelectorError(
					"unsupported-scheme",
					`Write resource selectors are not supported by this filesystem backend: ${path}`,
					{ path },
				);
			if (!isInternalUrl(path)) return definition.execute(toolCallId, params, signal, onUpdate, ctx);
			const sourcePath = path.startsWith("local://") ? resolveInternalSelector(path, executionCwd) : undefined;
			if (sourcePath) return definition.execute(toolCallId, { ...params, path: sourcePath }, signal, onUpdate, ctx);
			await writeInternalSelector(path, executionCwd, content, ctx as InternalResourceContext | undefined);
			return { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: {} };
		},
	};
}
