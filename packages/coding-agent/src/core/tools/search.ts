import { existsSync } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	createGrepToolDefinition,
	type GrepToolOptions,
} from "./grep.ts";
import { normalizePathLikeInput, splitPathLikeGlob } from "./glob-path-utils.ts";
import { loadNativeSearchBinding } from "./search-native.ts";
import { createHashlineSnapshotStore, recordHashlineSnapshot, type HashlineSnapshotStore } from "./hashline.ts";
import { invalidArgText, shortenPath, str } from "./render-utils.ts";
import { resolveToCwd } from "./path-utils.ts";
import { parseArchiveSelector, readArchiveSelector, resolveInternalSelector, searchArchiveSelector, searchInternalSelector, searchSqliteSelector, sqliteSelectorForPath, type InternalResourceContext, type SqliteSelector } from "./resource-selectors.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";
import { buildSearchDetails, type SearchToolDetails } from "./search-details.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
export type { SearchToolDetails } from "./search-details.ts";
const searchSchema = Type.Object({
	pattern: Type.String({ description: "Regex pattern. Whitespace-only patterns are rejected; otherwise the pattern is preserved verbatim." }),
	paths: Type.Optional(
		Type.Union([
			Type.String({ description: "File, directory, glob, internal URL, or <file>:<lines> selector to search. Omitted or empty searches the workspace root." }),
			Type.Array(Type.String({ description: "File, directory, glob, internal URL, or <file>:<lines> selector to search." })),
		]),
	),
	i: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore." })),
	case: Type.Optional(Type.Boolean({ description: "Set false for case-insensitive search (oh-my-pi compatibility)." })),
	skip: Type.Optional(Type.Union([Type.Number({ description: "Files to skip before collecting results; use to paginate when the previous call hit the file limit." }), Type.Null()])),
}, { additionalProperties: false });
export type SearchToolInput = Static<typeof searchSchema>;
export type SearchToolOptions = GrepToolOptions & { hashlineStore?: HashlineSnapshotStore; contextBefore?: number; contextAfter?: number };
function delimiterInExistingSearchGlobRoot(value: string, cwd: string): boolean { const selector = splitLineRangeSelector(value); const parsed = splitPathLikeGlob(selector.path); return !!parsed.glob && /[;,\s]/.test(parsed.basePath) && existsSync(resolveToCwd(parsed.basePath, cwd)); }
function archiveSelectorExists(value: string, cwd: string): boolean { const archive = parseArchiveSelector(value); if (!archive) return false; archive.archivePath = resolveToCwd(archive.archivePath, cwd); if (!existsSync(archive.archivePath)) return false; if (!archive.memberPath) return true; try { readArchiveSelector(archive); return true; } catch { return false; } }
function searchPathResolvable(value: string, cwd: string): boolean { const selector = splitLineRangeSelector(value), archive = parseArchiveSelector(selector.path); if (archive) return archiveSelectorExists(selector.path, cwd); const sqlite = sqliteSelectorForPath(selector.path, cwd); return !!sqlite || /^(?:skill|agent|artifact|history|issue|local|memory|pr|conflict|omp|rule|mcp|vault):\/\//.test(selector.path) || existsSync(resolveToCwd(splitPathLikeGlob(selector.path).basePath, cwd)); }

function normalizePaths(pathsValue: string | string[] | undefined, cwd: string): string[] {
	const inputs = Array.isArray(pathsValue) ? (pathsValue.length > 0 ? pathsValue : ["."]) : pathsValue === undefined ? ["."] : [pathsValue];
	const expanded: string[] = [];
	for (const input of inputs) {
		const raw = normalizePathLikeInput(input);
		if (raw === "") { expanded.push("."); continue; }
		const resourceLike = /^[a-z]+:\/\//i.test(raw) || /^[^:]+\.(?:zip|jar|tar|tgz|gz|sqlite|db):/i.test(raw);
		if (existsSync(resolveToCwd(splitLineRangeSelector(raw).path, cwd)) || delimiterInExistingSearchGlobRoot(raw, cwd) || archiveSelectorExists(raw, cwd)) { expanded.push(raw); continue; }
		const chunks = raw.split(/[;\s]+/).map(normalizePathLikeInput).filter(Boolean);
		const parts = chunks.flatMap((chunk) => searchPathResolvable(chunk, cwd) ? [chunk] : chunk.split(",").map(normalizePathLikeInput).filter(Boolean));
		if (parts.length > 1 && parts.every((part) => searchPathResolvable(part, cwd))) expanded.push(...parts);
		else if (resourceLike) expanded.push(raw);
		else expanded.push(raw);
	}
	return expanded;
}

interface SearchLineRange {
	start: number;
	end: number;
}

interface SearchTarget {
	path: string;
	glob?: string;
	lineRanges?: SearchLineRange[];
	archive?: ReturnType<typeof parseArchiveSelector>;
	sqlite?: SqliteSelector;
	internal?: string;
}

interface SearchOutputGroup {
	path: string;
	lines: string[];
}

interface PagedSearchOutputGroup {
	targetPath: string;
	virtual: boolean;
	group: SearchOutputGroup;
}

const DEFAULT_LIMIT = 20;
const INTERNAL_SKIP_LIMIT = 100_000;

function normalizeSkip(skip: number | null | undefined): number {
	if (skip === undefined || skip === null) return 0;
	if (!Number.isFinite(skip) || skip < 0) throw new Error("Skip must be a non-negative number");
	return Math.floor(skip);
}

function parseLineRangeSpec(spec: string): SearchLineRange[] | undefined {
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

function splitLineRangeSelector(value: string): { path: string; lineRanges?: SearchLineRange[] } {
	const match = value.match(/^(.*):(\d+(?:(?:-|\.\.|\+)\d*)?(?:,\d+(?:(?:-|\.\.|\+)\d*)?)*)$/);
	if (!match) return { path: value };
	const ranges = parseLineRangeSpec(match[2] ?? "");
	if (!ranges) throw new Error(`Invalid line-range selector: ${match[2] ?? ""}`); return { path: match[1] ?? value, lineRanges: ranges };
}

function isResourceSelector(value: string): boolean {
	return /^[^:]+\.(zip|jar|tar|tgz|gz|sqlite|db):/i.test(value) || /^[a-z]+:\/\//i.test(value) || value.startsWith("skill://");
}

function normalizeSearchTargets(pathsValue: string | string[] | undefined, cwd: string): SearchTarget[] {
	return normalizePaths(pathsValue, cwd).map((searchPath) => {
		const directSqlite = sqliteSelectorForPath(searchPath, cwd);
		if (directSqlite?.rowId) return { path: searchPath, sqlite: directSqlite };
		if (archiveSelectorExists(searchPath, cwd)) { const archive = parseArchiveSelector(searchPath)!; return { path: searchPath, archive }; }
		const selector = splitLineRangeSelector(searchPath);
		const sqliteDirect = sqliteSelectorForPath(selector.path, cwd);
		if (sqliteDirect) return { path: selector.path, lineRanges: selector.lineRanges, sqlite: sqliteDirect };
		const archive = parseArchiveSelector(selector.path);
		if (archive) return { path: selector.path, lineRanges: selector.lineRanges, archive };
		if (selector.path.startsWith("local://")) { const sourcePath = resolveInternalSelector(selector.path, cwd); if (sourcePath) { const parsed = splitPathLikeGlob(sourcePath); return { path: parsed.basePath, glob: parsed.glob, lineRanges: selector.lineRanges }; } }
		if (/^(?:skill|agent|artifact|history|issue|local|memory|pr|conflict|omp|rule|mcp|vault):\/\//.test(selector.path)) return { path: selector.path, lineRanges: selector.lineRanges, internal: selector.path };
		if (isResourceSelector(selector.path)) throw new Error(`Search resource selectors are not supported by this filesystem backend: ${searchPath}`);
		const parsed = splitPathLikeGlob(selector.path);
		return { path: parsed.basePath, glob: parsed.glob, lineRanges: selector.lineRanges };
	});
}

function filterSearchOutputByLineRange(text: string, target: SearchTarget): string {
	if (!target.lineRanges || target.lineRanges.length === 0) return text;
	const inRangeMatches: number[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^.+?:(\d+): /);
		if (!match) continue;
		const lineNumber = Number.parseInt(match[1] ?? "0", 10);
		if (target.lineRanges.some((range) => lineNumber >= range.start && lineNumber <= range.end)) inRangeMatches.push(lineNumber);
	}
	if (inRangeMatches.length === 0) return "No matches found";
	const filtered = text.split("\n").filter((line) => {
		const match = line.match(/^.+?(?::(\d+): |-(\d+)- )/);
		if (!match) return false;
		const lineNumber = Number.parseInt(match[1] ?? match[2] ?? "0", 10);
		return target.lineRanges!.some((range) => lineNumber >= range.start && lineNumber <= range.end);
	}).join("\n");
	return filtered || "No matches found";
}

function stripExtendedRegexWhitespace(pattern: string): string { let out = "", escaped = false, inClass = false, inComment = false; for (const ch of pattern) { if (inComment) { if (ch === "\n" || ch === "\r") inComment = false; continue; } if (escaped) { out += ch; escaped = false; continue; } if (ch === "\\") { out += ch; escaped = true; continue; } if (ch === "[") inClass = true; else if (ch === "]") inClass = false; if (!inClass && ch === "#") { inComment = true; continue; } if (!inClass && /\s/.test(ch)) continue; out += ch; } return out; }
function normalizeInlineSearchPattern(pattern: string, ignoreCase: boolean): { pattern: string; flags: string } { const match = pattern.match(/^\(\?([imsUx-]+)\)([\s\S]*)$/), flags = new Set<string>(); if (ignoreCase) flags.add("i"); if (match) { const inline = match[1] ?? ""; for (const flag of inline) if (flag === "i" || flag === "m" || flag === "s") flags.add(flag); return { pattern: inline.includes("x") ? stripExtendedRegexWhitespace(match[2] ?? "") : match[2] ?? "", flags: [...flags].join("") }; } return { pattern, flags: [...flags].join("") }; }


async function searchFileLineRanges(target: SearchTarget, cwd: string, pattern: string, ignoreCase: boolean, contextBefore = 1, contextAfter = 3): Promise<string | undefined> {
	if (!target.lineRanges?.length || target.glob || target.archive || target.sqlite || target.internal) return undefined;
	const absolutePath = resolveToCwd(target.path, cwd);
	if (!await fsStat(absolutePath).then((stat) => stat.isFile()).catch(() => false)) return undefined;
	const native = loadNativeSearchBinding();
	let text: string;
	if (native) {
		const result = await native.grep({ pattern, path: absolutePath, ignoreCase, contextBefore, contextAfter, maxColumns: 2000, cache: false });
		const rows: string[] = [];
		for (const match of result.matches) {
			for (const ctx of match.contextBefore ?? []) rows.push(`${target.path}-${ctx.lineNumber}- ${ctx.line}`);
			rows.push(`${target.path}:${match.lineNumber}: ${match.line}`);
			for (const ctx of match.contextAfter ?? []) rows.push(`${target.path}-${ctx.lineNumber}- ${ctx.line}`);
		}
		text = rows.join("\n") || "No matches found";
	} else {
		const source = (await fsReadFile(absolutePath, "utf8")).split("\n");
		const normalized = normalizeInlineSearchPattern(pattern, ignoreCase);
		const regex = new RegExp(normalized.pattern, normalized.flags);
		const matchLines = new Set<number>();
		source.forEach((line, index) => { regex.lastIndex = 0; if (regex.test(line)) matchLines.add(index + 1); });
		const outputLines = new Set<number>();
		for (const line of matchLines) for (let n = Math.max(1, line - contextBefore); n <= Math.min(source.length, line + contextAfter); n++) outputLines.add(n);
		text = [...outputLines].sort((a, b) => a - b).map((n) => `${target.path}${matchLines.has(n) ? ":" : "-"}${n}${matchLines.has(n) ? ":" : "-"} ${source[n - 1] ?? ""}`).join("\n") || "No matches found";
	}
	return filterSearchOutputByLineRange(text, target);
}

function groupSearchOutput(text: string): SearchOutputGroup[] {
	const groups: SearchOutputGroup[] = [];
	const byPath = new Map<string, SearchOutputGroup>();
	for (const line of text.split("\n")) {
		const match = line.match(/^(.+?)(?::[^:]+: |:\d+: |-\d+- )/);
		if (!match) continue;
		const filePath = match[1]!;
		let current = byPath.get(filePath);
		if (!current) { current = { path: filePath, lines: [] }; byPath.set(filePath, current); groups.push(current); }
		if (!current.lines.includes(line)) current.lines.push(line);
	}
	return groups;
}
function isVirtualSearchTarget(target: SearchTarget | undefined): boolean { return !!(target?.archive || target?.sqlite || target?.internal); }


async function addHashlineHeadersToSearchOutput(text: string, cwd: string, targetPath: string, hashlineStore: HashlineSnapshotStore): Promise<string> {
	const groups = groupSearchOutput(text);
	if (groups.length === 0) return text;
	const searchRoot = resolveToCwd(targetPath, cwd);
	const targetIsFile = await fsStat(searchRoot).then((stat) => stat.isFile()).catch(() => false);
	const rendered: string[] = [];
	let lastDir = "";
	for (const group of groups) {
		let absolutePath = targetIsFile ? searchRoot : join(searchRoot, group.path);
		try {
			await fsReadFile(absolutePath);
		} catch {
			absolutePath = resolvePath(cwd, group.path);
		}
		try {
			const content = await fsReadFile(absolutePath, "utf-8");
			const snapshot = recordHashlineSnapshot(absolutePath, cwd, content, hashlineStore);
			const dir = dirname(snapshot.displayPath);
			if (dir !== "." && dir !== lastDir) {
				rendered.push(`# ${dir}/`);
				lastDir = dir;
			}
			rendered.push(`[${snapshot.displayPath}#${snapshot.tag}]`);
			for (const line of group.lines) {
				const match = line.match(/^.+?(?::(\d+): |-(\d+)- )(.*)$/);
				if (match) rendered.push(`${match[1] ? "*" : " "}${match[1] ?? match[2]}:${match[3] ?? ""}`);
			}
		} catch {
			rendered.push(...group.lines);
		}
	}
	return rendered.join("\n");
}

function applyDefaultSearchContext(text: string, before = 1, after = 3): string {
	const groups = groupSearchOutput(text);
	if (groups.length === 0) return text;
	const output: string[] = [];
	for (const group of groups) {
		const byLine = new Map<number, { line: string; isMatch: boolean }>();
		for (const line of group.lines) {
			const match = line.match(/^(.+?)(?::(\d+): |-(\d+)- )(.*)$/);
			if (!match) continue;
			const number = Number.parseInt(match[2] ?? match[3] ?? "0", 10);
			const isMatch = match[2] !== undefined;
			const existing = byLine.get(number);
			if (!existing || (isMatch && !existing.isMatch)) byLine.set(number, { line, isMatch });
		}
		const matchNumbers = [...byLine.values()].filter((item) => item.isMatch).map((item) => Number.parseInt(item.line.match(/(?::(\d+): |-(\d+)- )/)?.[1] ?? item.line.match(/-(\d+)- /)?.[1] ?? "0", 10));
		for (const [number, item] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
			if (item.isMatch || matchNumbers.some((lineNumber) => number >= lineNumber - before && number <= lineNumber + after)) output.push(item.line);
		}
	}
	return output.join("\n");
}

function formatSearchGroups(groups: SearchOutputGroup[], limit: number, perFileLimit = 20): string {
	return groups.slice(0, Math.max(0, limit)).flatMap((group) => group.lines.slice(0, perFileLimit)).join("\n");
}

function dedupeRenderedSearchOutput(content: string): string {
	const out: string[] = [], seen = new Set<string>(); let header = "";
	for (const line of content.split("\n")) { const h = line.match(/^\[([^\]#]+)#[0-9A-F]{4}\]$/); if (h) header = h[1]!; const m = header ? line.match(/^[* ]?(\d+):/) : undefined; const key = m ? `${header}:${m[1]}` : ""; if (key && seen.has(key)) continue; if (key) seen.add(key); out.push(line); }
	return out.join("\n");
}
function formatSearchCall(
	args: { pattern: string; path?: string; paths?: string | string[]; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPaths = Array.isArray(args?.paths) ? args.paths.join(", ") : args?.paths;
	const rawPath = str(args?.path ?? rawPaths);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("search")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

export function createSearchToolDefinition(
	cwd: string,
	options?: SearchToolOptions,
): ToolDefinition<typeof searchSchema, SearchToolDetails | undefined> {
	const grepDefinition = createGrepToolDefinition(cwd, { ...options, nativeCache: false });
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return {
		...grepDefinition,
		name: "search",
		label: "search",
		description: "Search file contents with a regex across files, directories, globs, and internal URLs.",
		promptSnippet: "Search file contents with regex patterns.",
		parameters: searchSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resourceCtx = ctx as InternalResourceContext | undefined;
			if (params.pattern.trim() === "") throw new Error("Pattern must not be empty");
			const targets = normalizeSearchTargets(params.paths, cwd);
			const ignoreCase = params.i === true || params.case === false;
			const contextBefore = options?.contextBefore ?? 1, contextAfter = options?.contextAfter ?? 3, searchContext = Math.max(contextBefore, contextAfter);
			const isSingleFileSearch = targets.length === 1 && await fsStat(resolveToCwd(targets[0]!.path, cwd)).then((stat) => stat.isFile()).catch(() => false);
			const limit = isSingleFileSearch ? 200 : DEFAULT_LIMIT;
			let skip = normalizeSkip(params.skip);
			if (skip > 0 && isSingleFileSearch) skip = 0;
			for (const target of targets) {
				if (target.archive || target.sqlite || target.internal) continue;
				if (target.lineRanges && !await fsStat(resolveToCwd(target.path, cwd)).then((stat) => stat.isFile()).catch(() => false)) {
					throw new Error("Line-range search selectors are only supported for single files");
				}
			}
			const results: Awaited<ReturnType<typeof grepDefinition.execute>>[] = [];
			const groups: PagedSearchOutputGroup[] = [];
			const skippedMissingPaths: string[] = [];
			const scopePath = targets.map((target) => target.path).join(", ") || ".";
			let pageFullWithMore = false;
			let remaining = limit;
			const targetHasMatch = async (target: SearchTarget): Promise<boolean> => {
				if (target.archive || target.sqlite || target.internal) {
					const archive = target.archive ? { ...target.archive, archivePath: resolveToCwd(target.archive.archivePath, cwd) } : undefined;
					const text = archive ? searchArchiveSelector(archive, params.pattern, ignoreCase, false, contextBefore, contextAfter) : target.sqlite ? searchSqliteSelector(target.sqlite, params.pattern, ignoreCase, contextBefore, contextAfter) : await searchInternalSelector(target.internal!, cwd, params.pattern, ignoreCase, false, resourceCtx, contextBefore, contextAfter);
					return groupSearchOutput(filterSearchOutputByLineRange(text, target)).length > 0;
				}
				const ranged = await searchFileLineRanges(target, cwd, params.pattern, ignoreCase, contextBefore, contextAfter);
				if (ranged !== undefined) return groupSearchOutput(ranged).length > 0;
				const probe = await grepDefinition.execute(toolCallId, { pattern: params.pattern, path: target.path, glob: target.glob, ignoreCase, literal: false, context: 0, limit: 1, gitignore: params.gitignore }, signal, undefined, ctx);
				return probe.content.some((item) => item.type === "text" && item.text && item.text !== "No matches found");
			};
			for (const target of targets) {
				if (skip === 0 && remaining <= 0) { if (!target.archive && !target.sqlite && !target.internal && targets.length > 1 && await fsStat(resolveToCwd(target.path, cwd)).then(() => false).catch(() => true)) { skippedMissingPaths.push(target.path); continue; } if (await targetHasMatch(target)) { pageFullWithMore = true; break; } continue; }
				if (target.archive || target.sqlite || target.internal) {
					const archive = target.archive ? { ...target.archive, archivePath: resolveToCwd(target.archive.archivePath, cwd) } : undefined;
					let text = archive ? searchArchiveSelector(archive, params.pattern, ignoreCase, false, contextBefore, contextAfter) : target.sqlite ? searchSqliteSelector(target.sqlite, params.pattern, ignoreCase, contextBefore, contextAfter) : await searchInternalSelector(target.internal!, cwd, params.pattern, ignoreCase, false, resourceCtx, contextBefore, contextAfter);
					if (archive && target.archive) text = text.split(archive.archivePath).join(target.archive.archivePath); if (target.sqlite) text = text.split(target.sqlite.databasePath).join(target.path.match(/^(.+?\.(?:sqlite3?|db3?))/i)?.[1] ?? target.sqlite.databasePath); text = text || "No matches found";
					text = filterSearchOutputByLineRange(text, target);
					const outputGroups = groupSearchOutput(text);
					if (skip > 0) groups.push(...outputGroups.map((group) => ({ targetPath: target.path, virtual: isVirtualSearchTarget(target), group })) );
					else if (outputGroups.length > 0) {
						const hadMore = outputGroups.length > remaining;
						text = formatSearchGroups(outputGroups, remaining);
						if (hadMore) { text += `\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]`; pageFullWithMore = true; }
						remaining -= Math.min(remaining, outputGroups.length);
					} else if (text && text !== "No matches found") {
						remaining--;
					} else text = "No matches found";
					if (skip === 0) results.push({ content: [{ type: "text" as const, text }], details: undefined });
					continue;
				}
				if (targets.length > 1 && await fsStat(resolveToCwd(target.path, cwd)).then(() => false).catch(() => true)) {
					skippedMissingPaths.push(target.path);
					results.push({ content: [{ type: "text" as const, text: "No matches found" }], details: undefined });
					continue;
				}
				const rangedText = await searchFileLineRanges(target, cwd, params.pattern, ignoreCase, contextBefore, contextAfter);
				if (rangedText !== undefined) {
					let text = applyDefaultSearchContext(rangedText, contextBefore, contextAfter) || "No matches found";
					const result = { content: [{ type: "text" as const, text }], details: undefined as SearchToolDetails | undefined };
					results.push(result);
					const outputGroups = groupSearchOutput(text);
					if (skip > 0) groups.push(...outputGroups.map((group) => ({ targetPath: target.path, virtual: false, group })));
					else if (!isSingleFileSearch && outputGroups.length > 0) { const hadMore = outputGroups.length > remaining; text = formatSearchGroups(outputGroups, remaining); if (hadMore) { text += `\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]`; result.details = { matchLimitReached: limit }; } remaining -= Math.min(remaining, outputGroups.length); result.content = [{ type: "text", text }]; }
					continue;
				}
				const result = await grepDefinition.execute(
					toolCallId,
					{
						pattern: params.pattern,
						path: target.path,
						glob: target.glob,
						ignoreCase,
						literal: false,
						context: searchContext,
						limit: INTERNAL_SKIP_LIMIT,
						gitignore: params.gitignore,
					},
					signal,
					onUpdate,
					ctx,
				);
				results.push(result);
				let text = result.content
					.map((item) => (item.type === "text" ? item.text : undefined))
					.filter((text): text is string => typeof text === "string")
					.join("\n");
				text = filterSearchOutputByLineRange(text, target);
				if (text !== "No matches found") text = applyDefaultSearchContext(text, contextBefore, contextAfter) || "No matches found";
				const outputGroups = groupSearchOutput(text);
				if (skip > 0) groups.push(...outputGroups.map((group) => ({ targetPath: target.path, virtual: false, group })) );
				else if (!isSingleFileSearch && outputGroups.length > 0) {
					const hadMore = outputGroups.length > remaining;
					text = formatSearchGroups(outputGroups, remaining);
					if (hadMore) { text += `\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]`; result.details = { ...(result.details ?? {}), matchLimitReached: limit }; }
					remaining -= Math.min(remaining, outputGroups.length);
				}
				result.content = [{ type: "text", text }];
			}

			const details: SearchToolDetails = {};
			for (const result of results) {
				if (result.details?.truncation) details.truncation = result.details.truncation;
				if (result.details?.matchLimitReached) details.matchLimitReached = result.details.matchLimitReached;
				if (result.details?.linesTruncated) details.linesTruncated = true;
			}

			if (skip > 0) {
				const renderedPages: string[] = [];
				let remainingMatches = limit;
				for (const item of groups.slice(skip)) {
					if (remainingMatches <= 0) break;
					const raw = formatSearchGroups([item.group], 1);
					remainingMatches--;
					if (raw) renderedPages.push(item.virtual ? raw : await addHashlineHeadersToSearchOutput(raw, cwd, item.targetPath, hashlineStore));
				}
				const hasMorePages = groups.slice(skip + limit).length > 0;
				const output = `${renderedPages.join("\n\n") || `No more results (skip=${skip})`}${hasMorePages ? `\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]` : ""}`;
				if (hasMorePages) details.matchLimitReached = limit;
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				let content = truncation.content;
				if (truncation.truncated) {
					details.truncation = truncation;
					content += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} combined output limit reached]`;
				}
				return {
					content: [{ type: "text", text: content }],
					details: buildSearchDetails(details, content, cwd, scopePath, skippedMissingPaths),
				};
			}

			if (results.length === 1) {
				const result = results[0]!;
				let text = result.content
					.map((item) => (item.type === "text" ? item.text : undefined))
					.filter((value): value is string => typeof value === "string")
					.join("\n");
				text = filterSearchOutputByLineRange(text, targets[0]!);
				if (!isVirtualSearchTarget(targets[0]) && text !== "No matches found") text = applyDefaultSearchContext(text, contextBefore, contextAfter) || "No matches found";
				if (isSingleFileSearch && text !== "No matches found") text = formatSearchGroups(groupSearchOutput(text), limit, limit);
				if (text && text !== "No matches found") {
					const renderedText = isVirtualSearchTarget(targets[0]) ? text : await addHashlineHeadersToSearchOutput(text, cwd, targets[0]?.path ?? ".", hashlineStore);
					const pagedText = result.details?.matchLimitReached ? `${renderedText}\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]` : renderedText;
					const truncation = truncateHead(pagedText, { maxLines: Number.MAX_SAFE_INTEGER });
					if (truncation.truncated) return { ...result, content: [{ type: "text", text: `${truncation.content}\n\n[${formatSize(DEFAULT_MAX_BYTES)} combined output limit reached]` }], details: buildSearchDetails({ ...(result.details ?? {}), truncation }, truncation.content, cwd, scopePath, skippedMissingPaths) };
					return { ...result, content: [{ type: "text", text: pagedText }], details: buildSearchDetails(result.details, pagedText, cwd, scopePath, skippedMissingPaths) };
				}
				return { ...result, details: buildSearchDetails(result.details, text || "No matches found", cwd, scopePath, skippedMissingPaths) };
			}

			const renderedResults = await Promise.all(results.map(async (result, index) => {
				let text = result.content
					.map((item) => (item.type === "text" ? item.text : undefined))
					.filter((value): value is string => typeof value === "string" && value.length > 0)
					.join("\n");
				text = filterSearchOutputByLineRange(text, targets[index]!);
				if (!isVirtualSearchTarget(targets[index]) && text !== "No matches found") text = applyDefaultSearchContext(text, contextBefore, contextAfter);
				if (!text || text === "No matches found") return `# ${targets[index]?.path ?? "."}\n${text}`;
				return isVirtualSearchTarget(targets[index]) ? text : await addHashlineHeadersToSearchOutput(text, cwd, targets[index]?.path ?? ".", hashlineStore);
			}));
			const content = dedupeRenderedSearchOutput(`${renderedResults.join("\n\n")}${skippedMissingPaths.length > 0 ? `\n\n[Skipped missing paths: ${skippedMissingPaths.join(", ")}]` : ""}${pageFullWithMore ? `\n\n[${limit} matching files shown. Use skip=${skip + limit} to view more.]` : ""}`);
			if (pageFullWithMore) details.matchLimitReached = limit;
			const truncation = truncateHead(content, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				output += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} combined output limit reached]`;
			}
			return {
				content: [{ type: "text", text: output }],
				details: buildSearchDetails(details, output, cwd, scopePath, skippedMissingPaths),
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSearchCall(args, theme));
			return text;
		},
		renderResult(result, options: ToolRenderResultOptions, theme, context) {
			return grepDefinition.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
		},
	};
}

export function createSearchTool(cwd: string, options?: SearchToolOptions): AgentTool<typeof searchSchema> {
	return wrapToolDefinition(createSearchToolDefinition(cwd, options));
}
