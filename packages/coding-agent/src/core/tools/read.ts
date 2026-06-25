import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { parseConflictBlocks, registerConflictBlocks } from "./conflict-registry.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { buildDirectoryTree } from "./directory-tree.ts";
import { applyReadLineSelection, extractDocumentMarkdown, isDocumentPath } from "./read-document-extract.ts";
import { isReadableUrlPath } from "./fetch-url.ts";
import { readUrlBranch } from "./read-url.ts";
import { isNotebookPath, readEditableNotebookText } from "./notebook.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { createHashlineSnapshotStore, formatHashlineContent, recordHashlineSnapshot, type HashlineSnapshotStore } from "./hashline.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.ts";
import { formatHashlineSelectedLines, isReadResourceSelector, selectExactReadRanges, selectReadRanges, splitReadLineSelector, type ReadLineSelector } from "./read-selectors.ts";
import { parseArchiveSelector, readArchiveSelector, readInternalSelector, readSqliteSelector, resolveArchiveSelector, resolveInternalSelector, sqliteSelectorForPath, type InternalResourceContext } from "./resource-selectors.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
const readSchema = Type.Object({
	path: Type.String({ description: "File, directory, archive member, SQLite selector, internal resource, image, document, or URL to read. Append selectors such as :raw, :conflicts, :N, :A-B, :A+C, or :A-B,C-D to scope output." }),
}, { additionalProperties: false });
export type ReadToolInput = Static<typeof readSchema>;
const READ_TOOL_MAX_RESULT_CHARS = 50_000;
export interface OversizedReadDetails {
	blocked: true;
	path: string;
	chars: number;
	maxChars: number;
	startLine: number;
	requestedLimit?: number;
	totalFileLines: number;
	firstLineBytes: number;
	byteGuidance: boolean;
}
export interface ReadToolDetails {
	isDirectory?: boolean;
	resolvedPath?: string;
	truncation?: TruncationResult;
	oversizedRead?: OversizedReadDetails;
	meta?: { source?: string; sourcePath?: string; artifactId?: string; truncation?: TruncationResult; limits?: Record<string, number> };
}
interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}
const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};
export interface ReadToolOptions {
	autoResizeImages?: boolean;
	operations?: ReadOperations;
	hashlineStore?: HashlineSnapshotStore;
}
type ReadRenderArgs = { path?: string };
function formatReadLineRange(_args: ReadRenderArgs | undefined, _theme: Theme): string {
	return "";
}
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}
function trimTrailingEmptyLines(lines: string[]): string[] { let end = lines.length; while (end > 0 && lines[end - 1] === "") end--; return lines.slice(0, end); }
function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined { return !model || model.input.includes("image") ? undefined : "[Current model does not support images. The image will be omitted from this request.]"; }
function toPosixPath(filePath: string): string { return filePath.split(sep).join("/"); }
function formatCount(count: number): string { return count.toLocaleString("en-US"); }
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
function buildOversizedReadMessage(details: OversizedReadDetails): string {
	const pathForExample = JSON.stringify(details.path);
	const rangePathForExample = JSON.stringify(`${details.path}:${details.startLine}+200`);
	const shellPathForExample = shellQuote(details.path);
	const requestedLimitLine =
		details.requestedLimit !== undefined ? [`Requested line limit: ${formatCount(details.requestedLimit)}`] : [];
	if (details.byteGuidance) {
		return [
			`File read blocked: requested selected range is too large (${formatCount(details.chars)} chars; threshold: ${formatCount(details.maxChars)} chars).`,
			`Path: ${details.path}`,
			...requestedLimitLine,
			"",
			"The selected content starts with a single oversized line, so line pagination is not useful. Read byte slices instead. Examples:",
			`- Inspect the start of line ${details.startLine}: sed -n '${details.startLine}p' ${shellPathForExample} | head -c ${DEFAULT_MAX_BYTES}`,
			`- Inspect a later byte window: sed -n '${details.startLine}p' ${shellPathForExample} | tail -c +${DEFAULT_MAX_BYTES + 1} | head -c ${DEFAULT_MAX_BYTES}`,
			`- Search for relevant text first: search({ "pattern": "functionName", "paths": ${pathForExample} })`,
		].join("\n");
	}
	const targetedSnippetOffset = Math.max(details.startLine, 120);
	const snippetPathForExample = JSON.stringify(`${details.path}:${targetedSnippetOffset}+80`);
	return [
		`File read blocked: requested selected range is too large (${formatCount(details.chars)} chars; threshold: ${formatCount(details.maxChars)} chars).`,
		`Path: ${details.path}`,
		...requestedLimitLine,
		"",
		"Read only the needed context incrementally. Examples:",
		`- Search for relevant symbols first: search({ "pattern": "functionName", "paths": ${pathForExample} })`,
		`- Read a smaller line range: read({ "path": ${rangePathForExample} })`,
		`- Read a targeted snippet around a match: read({ "path": ${snippetPathForExample} })`,
	].join("\n");
}
function readSourceMeta(source: string): ReadToolDetails { return { meta: { source, sourcePath: source } }; }
function oversizedReadResult(details: OversizedReadDetails): { content: TextContent[]; details: ReadToolDetails } { return { content: [{ type: "text", text: buildOversizedReadMessage(details) }], details: { oversizedRead: details, meta: { source: details.path, sourcePath: details.path, limits: { maxChars: details.maxChars }, } } }; }
function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}
	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}
function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.path);
	if (!rawPath) return undefined;
	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}
	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}
	return undefined;
}
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} Expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}
	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}
function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	const oversizedRead = result.details?.oversizedRead;
	const oversizedReadBlocked = oversizedRead?.blocked === true;
	if (!options.expanded && !isError && !oversizedReadBlocked) {
		return "";
	}
	const rawPath = str(args?.path);
	const output = oversizedRead ? buildOversizedReadMessage(oversizedRead) : getTextOutput(result, showImages);
	const lang = rawPath && !oversizedReadBlocked ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "Expand")}${theme.fg("muted", ")")}`;
	}
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}
function archiveSelectorMemberExists(pathValue: string, cwd: string): boolean { const archive = parseArchiveSelector(pathValue); if (!archive || !archive.memberPath) return false; try { readArchiveSelector(resolveArchiveSelector(archive, cwd)); return true; } catch { return false; } }
function appendReadSelectors(pathValue: string, selector: ReadLineSelector): string {
	const range = selector.ranges?.map((item) => item.end === undefined ? `${item.start}` : `${item.start}-${item.end}`).join(",") ?? (selector.offset ? `${selector.offset}` : "");
	return `${pathValue}${range ? `:${range}` : ""}${selector.conflicts ? ":conflicts" : ""}${selector.raw ? ":raw" : ""}`;
}
export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return {
		name: "read",
		label: "read",
		description: "Read files, directories, archives, SQLite databases, internal resources, images, documents, and URLs through one path string.",
		promptSnippet: "Read a path selector.",
		promptGuidelines: ["Use read to inspect file and resource contents; use path selectors for line ranges, raw output, and conflict views."],
		parameters: readSchema,
		maxResultSizeChars: Infinity,
		async execute(
			_toolCallId,
			{ path }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const resourceCtx = ctx as InternalResourceContext | undefined;
			const splitSelector = splitReadLineSelector(path), markerless = path.replace(/:raw(?=(:|$))/g, "").replace(/:conflicts(?=(:|$))/g, ""), sqliteOriginal = sqliteSelectorForPath(markerless, cwd), sqliteDirect = sqliteSelectorForPath(path, cwd);
			const selector = archiveSelectorMemberExists(path, cwd) ? { path } : sqliteDirect && (sqliteDirect.table === "raw" || sqliteDirect.table === "conflicts") ? { path } : sqliteOriginal?.rowId && splitSelector.path !== markerless ? { path: markerless, raw: splitSelector.raw, conflicts: splitSelector.conflicts } : sqliteOriginal && splitSelector.path === markerless && markerless !== path ? { path: markerless, raw: splitSelector.raw, conflicts: splitSelector.conflicts } : splitSelector.path === path && sqliteDirect ? { path } : splitSelector;
			const effectivePath = selector.path;
			const effectiveOffset = selector.offset;
			const effectiveLimit = selector.limit;
			const effectiveRanges = selector.ranges;
			const rawOutput = selector.raw;
			const conflictsOnly = selector.conflicts;
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					(async () => {
						try {
							const archive = parseArchiveSelector(effectivePath);
							const sqlite = sqliteSelectorForPath(effectivePath, cwd);
							if (isReadableUrlPath(effectivePath)) {
								resolve(await readUrlBranch({ effectivePath, rawOutput: rawOutput === true, effectiveRanges, effectiveOffset, effectiveLimit, cwd, ctx, signal, maxChars: READ_TOOL_MAX_RESULT_CHARS, maxBytes: DEFAULT_MAX_BYTES, oversized: oversizedReadResult, sourceMeta: readSourceMeta }));
								return;
							}
							if (sqlite) {
								const textContent = readSqliteSelector(sqlite), selection = applyReadLineSelection(textContent.split("\n"), effectiveRanges, effectiveOffset, effectiveLimit, rawOutput), selectedText = selection.lines.join("\n");
								if ((effectiveRanges || effectiveOffset) && selection.lines.length === 0) { const requested = effectiveRanges?.[0]?.start ?? effectiveOffset ?? 1; resolve({ content: [{ type: "text", text: `Requested line ${requested} is beyond end of resource (${textContent.split("\n").length} lines total).` }], details: undefined }); return; }
								if (selectedText.length > READ_TOOL_MAX_RESULT_CHARS || Buffer.byteLength(selectedText, "utf8") > DEFAULT_MAX_BYTES) { resolve(oversizedReadResult({ blocked: true, path: effectivePath, chars: selectedText.length, maxChars: READ_TOOL_MAX_RESULT_CHARS, startLine: selection.firstLine, totalFileLines: textContent.split("\n").length, firstLineBytes: Buffer.byteLength(selection.lines[0] ?? "", "utf8"), byteGuidance: false })); return; }
							resolve({ content: [{ type: "text", text: selectedText }], details: readSourceMeta(effectivePath) }); return;
							}
							if (archive) {
								const resolvedArchive = resolveArchiveSelector(archive, cwd);
								const textContent = readArchiveSelector(resolvedArchive);
								let allLines = textContent.split("\n");
								if (conflictsOnly) {
									let inConflict = false;
									const conflictLines = allLines.filter((line) => { if (line.startsWith("<<<<<<<")) inConflict = true; const keep = inConflict; if (line.startsWith(">>>>>>>")) inConflict = false; return keep; });
									if (conflictLines.length === 0) { resolve({ content: [{ type: "text", text: "No conflict markers found" }], details: undefined }); return; }
									allLines = conflictLines;
								}
								const rangeSelection = (rawOutput ? selectExactReadRanges : selectReadRanges)(allLines, effectiveRanges);
								const startLine = rangeSelection ? rangeSelection.firstLine - 1 : effectiveOffset ? Math.max(0, effectiveOffset - 1) : 0;
								if (startLine >= allLines.length || (effectiveRanges && rangeSelection?.selectedLines.length === 0)) {
									resolve({ content: [{ type: "text", text: `Requested line ${startLine + 1} is beyond end of resource (${allLines.length} lines total).` }], details: undefined });
									return;
								}
								const endLine = effectiveLimit !== undefined ? Math.min(startLine + effectiveLimit, allLines.length) : allLines.length;
								const selectedLines = rangeSelection?.selectedLines ?? allLines.slice(startLine, endLine);
								const selectedText = selectedLines.join("\n");
								if (selectedText.length > READ_TOOL_MAX_RESULT_CHARS || Buffer.byteLength(selectedText, "utf8") > DEFAULT_MAX_BYTES) { resolve(oversizedReadResult({ blocked: true, path: `${resolvedArchive.archivePath}:${resolvedArchive.memberPath}`, chars: selectedText.length, maxChars: READ_TOOL_MAX_RESULT_CHARS, startLine: startLine + 1, totalFileLines: allLines.length, firstLineBytes: Buffer.byteLength(selectedLines[0] ?? "", "utf8"), byteGuidance: false })); return; }
							resolve({ content: [{ type: "text", text: selectedText }], details: readSourceMeta(`${resolvedArchive.archivePath}:${resolvedArchive.memberPath}`) });
								return;
							}
							if (/^(?:skill|agent|artifact|history|issue|local|memory|pr|conflict|omp|rule|mcp|vault):\/\//.test(effectivePath)) {
								const sourcePath = effectivePath.startsWith("local://") ? resolveInternalSelector(effectivePath, cwd) : undefined;
								if (sourcePath) { resolve(await createReadToolDefinition(cwd, options).execute(_toolCallId, { path: appendReadSelectors(sourcePath, selector) }, signal, _onUpdate, ctx as never)); return; }
								const allLines = (await readInternalSelector(effectivePath, cwd, resourceCtx)).split("\n");
								const rangeSelection = (rawOutput ? selectExactReadRanges : selectReadRanges)(allLines, effectiveRanges);
								const startLine = rangeSelection ? rangeSelection.firstLine - 1 : effectiveOffset ? Math.max(0, effectiveOffset - 1) : 0;
								if (startLine >= allLines.length || (effectiveRanges && rangeSelection?.selectedLines.length === 0)) {
									resolve({ content: [{ type: "text", text: `Requested line ${startLine + 1} is beyond end of resource (${allLines.length} lines total).` }], details: undefined });
									return;
								}
								const endLine = effectiveLimit !== undefined ? Math.min(startLine + effectiveLimit, allLines.length) : allLines.length;
								const selectedLines = rangeSelection?.selectedLines ?? allLines.slice(startLine, endLine);
								const selectedText = selectedLines.join("\n");
								if (selectedText.length > READ_TOOL_MAX_RESULT_CHARS || Buffer.byteLength(selectedText, "utf8") > DEFAULT_MAX_BYTES) { resolve(oversizedReadResult({ blocked: true, path: effectivePath, chars: selectedText.length, maxChars: READ_TOOL_MAX_RESULT_CHARS, startLine: startLine + 1, totalFileLines: allLines.length, firstLineBytes: Buffer.byteLength(selectedLines[0] ?? "", "utf8"), byteGuidance: false })); return; }
							resolve({ content: [{ type: "text", text: selectedText }], details: readSourceMeta(effectivePath) });
								return;
							}
							if (isReadResourceSelector(effectivePath)) throw new Error(`Read resource selectors are not supported by this filesystem backend: ${path}`);
							const absolutePath = await resolveReadPathAsync(effectivePath, cwd);
							if (aborted) return;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							await ops.access(absolutePath);
							if (aborted) return;
							if (isDocumentPath(absolutePath) && !rawOutput && !isNotebookPath(absolutePath)) {
								const buffer = await ops.readFile(absolutePath);
								const textContent = await extractDocumentMarkdown(buffer, absolutePath);
								const selection = applyReadLineSelection(textContent.split("\n"), effectiveRanges, effectiveOffset, effectiveLimit, rawOutput);
								if (selection.lines.length === 0) { resolve({ content: [{ type: "text", text: `Requested line ${selection.firstLine} is beyond end of document (${textContent.split("\n").length} lines total).` }], details: undefined }); return; }
								const selectedText = selection.lines.join("\n");
							if (selectedText.length > READ_TOOL_MAX_RESULT_CHARS || Buffer.byteLength(selectedText, "utf8") > DEFAULT_MAX_BYTES) { resolve(oversizedReadResult({ blocked: true, path: absolutePath, chars: selectedText.length, maxChars: READ_TOOL_MAX_RESULT_CHARS, startLine: selection.firstLine, totalFileLines: textContent.split("\n").length, firstLineBytes: Buffer.byteLength(selection.lines[0] ?? "", "utf8"), byteGuidance: false })); return; }
							content = [{ type: "text", text: selectedText }]; resolve({ content, details: readSourceMeta(absolutePath) }); return;
							}
							if (!options?.operations && (await fsStat(absolutePath)).isDirectory()) {
								const tree = await buildDirectoryTree(absolutePath, { maxDepth: 2, perDirLimit: 12, rootLimit: null });
								const allLines = tree.rendered.split("\n"), rangeSelection = (rawOutput ? selectExactReadRanges : selectReadRanges)(allLines, effectiveRanges), startLine = rangeSelection ? rangeSelection.firstLine - 1 : effectiveOffset ? Math.max(0, effectiveOffset - 1) : 0;
								if (startLine >= allLines.length || (effectiveRanges && rangeSelection?.selectedLines.length === 0)) { resolve({ content: [{ type: "text", text: `Requested line ${startLine + 1} is beyond end of directory (${allLines.length} lines total).` }], details: undefined }); return; }
								const endLine = effectiveLimit !== undefined ? Math.min(startLine + effectiveLimit, allLines.length) : allLines.length, selectedLines = rangeSelection?.selectedLines ?? allLines.slice(startLine, endLine);
								content = [{ type: "text", text: selectedLines.join("\n") }];
								const meta = { ...readSourceMeta(absolutePath).meta, ...(tree.truncated ? { limits: { perDirLimit: 12, totalLines: tree.totalLines } } : {}) };
								resolve({ content, details: { isDirectory: true, resolvedPath: absolutePath, meta } });
								return;
							}
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								if (nonVisionImageNote) {
									content = [{ type: "text", text: `Read image file [${mimeType}]\n${nonVisionImageNote}` }];
								} else {
									const buffer = await ops.readFile(absolutePath);
									if (autoResizeImages) {
										const resized = await resizeImage(buffer, mimeType);
										if (!resized) {
											const textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
											content = [{ type: "text", text: textNote }];
										} else {
											const dimensionNote = formatDimensionNote(resized);
											let textNote = `Read image file [${resized.mimeType}]`;
											if (dimensionNote) textNote += `\n${dimensionNote}`;
											content = [
												{ type: "text", text: textNote },
												{ type: "image", data: resized.data, mimeType: resized.mimeType },
											];
										}
									} else {
										const textNote = `Read image file [${mimeType}]`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: buffer.toString("base64"), mimeType },
										];
									}
								}
							} else {
								const buffer = await ops.readFile(absolutePath);
								const textContent = (isNotebookPath(absolutePath) && !rawOutput) ? readEditableNotebookText(absolutePath, effectivePath) : buffer.toString("utf-8");
								let allLines = textContent.split("\n");
								let conflictLineNumbers: number[] | undefined;
								if (conflictsOnly) {
									registerConflictBlocks(cwd, parseConflictBlocks(absolutePath, textContent));
									const conflictLines: string[] = [];
									conflictLineNumbers = [];
									let inConflict = false;
									allLines.forEach((line, index) => {
										if (line.startsWith("<<<<<<<")) inConflict = true;
										if (inConflict) { conflictLines.push(line); conflictLineNumbers!.push(index + 1); }
										if (line.startsWith(">>>>>>>")) inConflict = false;
									});
									if (conflictLines.length > 0) allLines = conflictLines;
									else { signal?.removeEventListener("abort", onAbort); resolve({ content: [{ type: "text", text: "No conflict markers found" }], details: undefined }); return; }
								}
								const totalFileLines = allLines.length;
								const rangeSelection = (rawOutput ? selectExactReadRanges : selectReadRanges)(allLines, effectiveRanges);
								const startLine = rangeSelection ? rangeSelection.firstLine - 1 : effectiveOffset ? Math.max(0, effectiveOffset - 1) : 0;
								const startLineDisplay = startLine + 1;
								if (startLine >= allLines.length || (effectiveRanges && rangeSelection?.selectedLines.length === 0)) {
									const requested = effectiveRanges?.[0]?.start ?? startLineDisplay;
									resolve({ content: [{ type: "text", text: `Requested line ${requested} is beyond end of file (${allLines.length} lines total). Use ${effectivePath}:${Math.max(1, allLines.length)} to read the final line.` }], details: undefined });
									return;
								}
								let selectedContent: string;
								let selectedLines: string[];
								let userLimitedLines: number | undefined;
								if (rangeSelection) {
									selectedLines = rangeSelection.selectedLines;
									selectedContent = rangeSelection.selectedContent;
									userLimitedLines = rangeSelection.userLimitedLines;
								} else if (effectiveLimit !== undefined) {
									const endLine = Math.min(startLine + effectiveLimit, allLines.length);
									selectedLines = allLines.slice(startLine, endLine);
									selectedContent = selectedLines.join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedLines = allLines.slice(startLine);
									selectedContent = selectedLines.join("\n");
								}
								if (selectedContent.length > READ_TOOL_MAX_RESULT_CHARS) {
									const firstSelectedLine = allLines[startLine] ?? "";
									const firstLineBytes = Buffer.byteLength(firstSelectedLine, "utf-8");
									const selectedLineCount = trimTrailingEmptyLines(selectedLines).length;
									const byteGuidance = selectedLineCount <= 1 || firstLineBytes > DEFAULT_MAX_BYTES;
									const oversizedRead: OversizedReadDetails = { blocked: true, path: absolutePath, chars: selectedContent.length, maxChars: READ_TOOL_MAX_RESULT_CHARS, startLine: startLineDisplay, ...(effectiveLimit !== undefined ? { requestedLimit: effectiveLimit } : {}), totalFileLines, firstLineBytes, byteGuidance };
								details = { oversizedRead, meta: readSourceMeta(absolutePath).meta };
									content = [{ type: "text", text: buildOversizedReadMessage(oversizedRead) }];
								} else {
									const truncation = truncateHead(selectedContent);
									let outputText = truncation.content;
									if (truncation.firstLineExceedsLimit) {
										const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
										outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${effectivePath} | head -c ${DEFAULT_MAX_BYTES}]`;
						details = { truncation, meta: { source: absolutePath, sourcePath: absolutePath, truncation } };
									} else if (truncation.truncated) {
										const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
										const nextOffset = endLineDisplay + 1;
										outputText += truncation.truncatedBy === "lines" ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Continue with path selector :${nextOffset}.]` : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Continue with path selector :${nextOffset}.]`;
						details = { truncation, meta: { source: absolutePath, sourcePath: absolutePath, truncation } };
									} else if (!rawOutput && userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
										const remaining = allLines.length - (startLine + userLimitedLines);
										const nextOffset = startLine + userLimitedLines + 1;
										outputText = `${truncation.content}\n\n[${remaining} more lines in file. Continue with path selector :${nextOffset}.]`;
									}
									if (truncation.firstLineExceedsLimit) content = [{ type: "text", text: outputText }];
									else {
										const snapshot = recordHashlineSnapshot(absolutePath, cwd, textContent, hashlineStore);
										const visibleContent = truncation.truncated ? truncation.content : selectedContent;
										const header = `[${snapshot.displayPath}#${snapshot.tag}]`;
										const selectedConflictLineNumbers = conflictLineNumbers && rangeSelection?.lineNumbers ? rangeSelection.lineNumbers.map((line) => conflictLineNumbers![line - 1]).filter((line): line is number => typeof line === "number") : conflictLineNumbers ? conflictLineNumbers.slice(startLine, startLine + selectedLines.length) : undefined;
										let hashlineOutput = rawOutput ? visibleContent : selectedConflictLineNumbers && visibleContent === selectedContent ? formatHashlineSelectedLines(header, selectedLines, selectedConflictLineNumbers) : rangeSelection && visibleContent === selectedContent ? formatHashlineSelectedLines(header, selectedLines, rangeSelection.lineNumbers) : formatHashlineContent(snapshot, visibleContent, startLineDisplay);
										if (outputText.startsWith(truncation.content) && outputText.length > truncation.content.length) hashlineOutput += outputText.slice(truncation.content.length);
										content = [{ type: "text", text: hashlineOutput }];
									}
								}
							}
							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
						resolve({ content, details: details ?? readSourceMeta(absolutePath) });
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}
export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
