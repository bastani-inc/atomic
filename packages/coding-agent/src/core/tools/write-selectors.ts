import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ToolDefinition } from "../extensions/types.ts";
import { type ConflictBlock, findConflictBlocks, reconcileConflictBlocks } from "./conflict-registry.ts";
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

function conflictReplacement(content: string, block: ConflictBlock): string[] {
	const token = content.trim();
	if (token === "@ours") return block.ours;
	if (token === "@theirs") return block.theirs;
	if (token === "@base") return block.base;
	const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
	return normalized === "" ? [] : normalized.split("\n");
}

async function resolveConflictBlocks(blocks: ConflictBlock[], content: string): Promise<void> {
	const byFile = new Map<string, ConflictBlock[]>();
	for (const block of blocks) byFile.set(block.file, [...(byFile.get(block.file) ?? []), block]);
	for (const [file, fileBlocks] of byFile) {
		const lines = (await fsReadFile(file, "utf8")).split("\n");
		for (const block of fileBlocks.sort((a, b) => b.start - a.start))
			lines.splice(block.start, block.end - block.start + 1, ...conflictReplacement(content, block));
		await fsWriteFile(file, lines.join("\n"), "utf8");
		invalidateNativeSearchCache(file);
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
	const liveBlocks = await findConflictBlocks(cwd);
	if (liveBlocks.length === 0)
		throw new WriteSelectorError("conflict-markers-not-found", "No conflict markers found.", { path });
	const blocks = reconcileConflictBlocks(liveBlocks, cwd);
	if (target === "*") {
		await resolveConflictBlocks(blocks, content);
		const text = `Resolved ${blocks.length} conflict${blocks.length === 1 ? "" : "s"}`;
		return { content: [{ type: "text", text }], details: undefined };
	}
	if (!/^\d+$/.test(target))
		throw new WriteSelectorError(
			"conflict-target-invalid",
			"Conflict writes must target conflict://<id> or conflict://*.",
			{ path, conflictId: target },
		);
	const block = blocks[Number.parseInt(target, 10) - 1];
	if (!block)
		throw new WriteSelectorError("conflict-id-not-found", `Conflict id not found: ${target}`, {
			path,
			conflictId: target,
		});
	await resolveConflictBlocks([block], content);
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
