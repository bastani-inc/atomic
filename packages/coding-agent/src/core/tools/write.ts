import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { chmod as fsChmod, mkdir as fsMkdir, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getRegisteredConflictBlocks, parseConflictBlocks, type ConflictBlock } from "./conflict-registry.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { createHashlineSnapshotStore, formatHashlineContent, recordHashlineSnapshot, stripKnownHashlineCopiedContent, stripKnownHashlineCopiedContentWithMeta, type HashlineSnapshotStore } from "./hashline.ts";
import { resolveToCwd } from "./path-utils.ts";
import { parseArchiveSelector, parseSqliteSelector, resolveArchiveSelector, resolveInternalSelector, sqliteSelectorForPath, writeArchiveSelector, writeInternalSelector, writeSqliteSelector, type InternalResourceContext } from "./resource-selectors.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import { invalidArgText, normalizeDisplayText, replaceTabs, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path, writable internal resource, archive entry, SQLite row selector, or conflict resolution target." }),
	content: Type.String({ description: "Full replacement content. SQLite non-delete writes parse as a JSON5 object; empty content deletes a SQLite row when a row key exists." }),
}, { additionalProperties: false });

export type WriteToolInput = Static<typeof writeSchema>;
export interface WriteToolDetails { resolvedPath?: string; madeExecutable?: boolean; meta?: { sourcePath?: string; diagnostics?: unknown }; diagnostics?: unknown }

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}


async function findConflictBlocks(root: string, limit = 100): Promise<ConflictBlock[]> {
	const out: ConflictBlock[] = [];
	async function walk(dir: string): Promise<void> { for (const entry of await fsReaddir(dir, { withFileTypes: true }).catch(() => [])) { if (out.length >= limit || entry.name === ".git" || entry.name === "node_modules") continue; const full = `${dir}/${entry.name}`; if (entry.isDirectory()) await walk(full); else if (entry.isFile()) { const text = await fsReadFile(full, "utf8").catch(() => ""); if (text.includes("<<<<<<<") && text.includes("=======") && text.includes(">>>>>>>")) out.push(...parseConflictBlocks(full, text)); } } }
	await walk(root); return out;
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
function reconcileConflictBlocks(live: ConflictBlock[], cwd: string): ConflictBlock[] {
	const registered = getRegisteredConflictBlocks(cwd);
	if (registered.length === 0) return live;
	const liveKeys = new Set(live.map((block) => `${block.file}\0${block.start}\0${block.end}`));
	const registeredLive = registered.filter((block) => liveKeys.has(`${block.file}\0${block.start}\0${block.end}`));
	// If the registered view no longer matches the live tree at all, the file
	// changed under us — trust the live walk rather than a stale id mapping.
	return registeredLive.length > 0 ? registeredLive : live;
}
function conflictReplacement(content: string, block: ConflictBlock): string[] {
	const token = content.trim();
	if (token === "@ours") return block.ours;
	if (token === "@theirs") return block.theirs;
	if (token === "@base") return block.base;
	const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
	return normalized === "" ? [] : normalized.split("\n");
}
async function resolveConflictBlocks(blocks: ConflictBlock[], content: string): Promise<string[]> {
	const byFile = new Map<string, ConflictBlock[]>();
	for (const block of blocks) byFile.set(block.file, [...(byFile.get(block.file) ?? []), block]);
	const written: string[] = [];
	for (const [file, fileBlocks] of byFile) {
		const text = await fsReadFile(file, "utf8"), lines = text.split("\n");
		for (const block of fileBlocks.sort((a, b) => b.start - a.start)) lines.splice(block.start, block.end - block.start + 1, ...conflictReplacement(content, block));
		await fsWriteFile(file, lines.join("\n"), "utf8"); written.push(file);
	}
	return written;
}
async function conflictSnapshotHeaders(files: string[], cwd: string, store: HashlineSnapshotStore): Promise<string[]> {
	const headers: string[] = [];
	for (const file of [...new Set(files)]) { invalidateNativeSearchCache(file); const text = await fsReadFile(file, "utf8").catch(() => undefined); if (text !== undefined) headers.push(formatHashlineContent(recordHashlineSnapshot(file, cwd, text, store)).split("\n")[0]!); }
	return headers;
}
const GENERATED_MARKER_BYTES = 1024;
const GENERATED_MARKER_LINES = 40;
function hasGeneratedMarker(text: string): boolean {
	const header = text.slice(0, GENERATED_MARKER_BYTES).split("\n").slice(0, GENERATED_MARKER_LINES);
	return header.some((line) => /@generated|auto-generated|DO NOT EDIT|GENERATED -- do not edit/i.test(line));
}
function strippedHashlineNote(stripped: boolean): string { return stripped ? "\n\nNote: stripped copied hashline headers and line prefixes before writing." : ""; }
function hashlineHeaderForWrite(path: string, cwd: string, content: string, store: HashlineSnapshotStore): string { const snapshot = recordHashlineSnapshot(path, cwd, content, store); return `[${snapshot.displayPath}#${snapshot.tag}]`; }
const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	hashlineStore?: HashlineSnapshotStore;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatWriteCall(
	args: { path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cache: WriteHighlightCache | undefined,
): string {
	const rawPath = str(args?.path);
	const fileContent = str(args?.content);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "Expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return {
		name: "write",
		label: "write",
		description: "Create or overwrite a file, writable internal resource, archive entry, SQLite row, or merge-conflict resolution.",
		promptSnippet: "Create or overwrite a writable path selector.",
		promptGuidelines: ["Use write when replacing the full content of a target; use edit for source edits anchored to existing hashline snapshots."],
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const resourceCtx = _ctx as InternalResourceContext | undefined;
			const archive = parseArchiveSelector(path);
			const parsedSqlite = parseSqliteSelector(path);
			if (parsedSqlite?.table && path.includes("?")) throw new Error("SQLite write selectors must not include query parameters.");
			if (parsedSqlite?.table && (parsedSqlite.limit !== undefined || parsedSqlite.offset !== undefined || parsedSqlite.where || parsedSqlite.order || parsedSqlite.schema || parsedSqlite.sampleRows !== undefined || parsedSqlite.query)) throw new Error("SQLite write selectors must not include query parameters.");
			const sqlite = sqliteSelectorForPath(path, cwd);
			if (!sqlite && parsedSqlite?.table) throw new Error(`SQLite database not found or is not SQLite: ${path}`);
			if (sqlite) {
				const stripped = stripKnownHashlineCopiedContentWithMeta(content, "", cwd, hashlineStore);
				const message = writeSqliteSelector(sqlite, stripped.content);
				return { content: [{ type: "text", text: `${message}${strippedHashlineNote(stripped.stripped)}` }], details: { meta: { sourcePath: sqlite.databasePath } } };
			}
			if (archive) {
				const stripped = stripKnownHashlineCopiedContentWithMeta(content, "", cwd, hashlineStore);
				const resolvedArchive = resolveArchiveSelector(archive, cwd);
				writeArchiveSelector(resolvedArchive, stripped.content);
				return { content: [{ type: "text", text: `Successfully wrote ${stripped.content.length} bytes to ${path}${strippedHashlineNote(stripped.stripped)}` }], details: { resolvedPath: resolvedArchive.archivePath } };
			}
			if (path.startsWith("conflict://")) {
				const writeContent = stripKnownHashlineCopiedContent(content, "", cwd, hashlineStore);
				const target = decodeURIComponent(path.slice("conflict://".length));
				if (!target) throw new Error("conflict:// target is required.");
				if (target.includes("/")) throw new Error("Scoped conflict resources are read-only; write conflict://<id> or conflict://*.");
				const liveBlocks = await findConflictBlocks(cwd);
				if (liveBlocks.length === 0) throw new Error("No conflict markers found.");
				const blocks = reconcileConflictBlocks(liveBlocks, cwd);
				if (target === "*") { const headers = await conflictSnapshotHeaders(await resolveConflictBlocks(blocks, writeContent), cwd, hashlineStore); return { content: [{ type: "text", text: `Resolved ${blocks.length} conflict${blocks.length === 1 ? "" : "s"}${headers.length > 0 ? `\n\nSnapshots:\n${headers.join("\n")}` : ""}` }], details: undefined }; }
				if (!/^\d+$/.test(target)) throw new Error("Conflict writes must target conflict://<id> or conflict://*.");
				const id = Number.parseInt(target, 10);
				const block = blocks[id - 1];
				if (!block) throw new Error(`Conflict id not found: ${target}`);
				const headers = await conflictSnapshotHeaders(await resolveConflictBlocks([block], writeContent), cwd, hashlineStore);
				return { content: [{ type: "text", text: `Resolved conflict ${target}${headers[0] ? `\n\n${headers[0]}` : ""}` }], details: undefined };
			}
			if (/^[a-z]+:\/\//i.test(path)) {
				const sourcePath = path.startsWith("local://") ? resolveInternalSelector(path, cwd) : undefined;
				if (sourcePath) return createWriteToolDefinition(cwd, options).execute(_toolCallId, { path: sourcePath, content }, signal, _onUpdate, _ctx as never);
				const stripped = stripKnownHashlineCopiedContentWithMeta(content, "", cwd, hashlineStore);
				await writeInternalSelector(path, cwd, stripped.content, resourceCtx);
				return { content: [{ type: "text", text: `Successfully wrote ${stripped.content.length} bytes to ${path}${strippedHashlineNote(stripped.stripped)}` }], details: {} };
			}
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				const existing = await fsReadFile(absolutePath, "utf8").catch(() => undefined);
				if (existing !== undefined && hasGeneratedMarker(existing)) throw new Error(`Refusing to overwrite generated file: ${path}`);
				const stripped = stripKnownHashlineCopiedContentWithMeta(content, absolutePath, cwd, hashlineStore);
				const writeContent = stripped.content;
				await ops.writeFile(absolutePath, writeContent);
				invalidateNativeSearchCache(absolutePath);
				let madeExecutable = false;
				if (writeContent.startsWith("#!")) {
					const mode = await fsStat(absolutePath).then((stat) => stat.mode).catch(() => undefined);
					if (mode !== undefined) { await fsChmod(absolutePath, mode | 0o111); madeExecutable = true; }
				}
				throwIfAborted();

				const header = hashlineHeaderForWrite(absolutePath, cwd, writeContent, hashlineStore);
				return {
					content: [{ type: "text", text: `${header}\nSuccessfully wrote ${writeContent.length} bytes to ${path}${strippedHashlineNote(stripped.stripped)}` }],
					details: { resolvedPath: absolutePath, ...(madeExecutable ? { madeExecutable } : {}) },
				};
			});
		},
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; content?: string } | undefined;
			const rawPath = str(renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
