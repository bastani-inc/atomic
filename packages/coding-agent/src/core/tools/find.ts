import { statSync } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { normalizePathLikeInput, splitPathLikeGlob } from "./glob-path-utils.ts";
import { loadNativeSearchBinding } from "./search-native.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { resolveInternalSelector, type InternalResourceContext } from "./resource-selectors.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
const toPosixPath = (value: string): string => value.split(path.sep).join("/");
const findSchema = Type.Object({
	paths: Type.Array(Type.String({ description: "File, directory, or glob path to find." }), { description: "Paths or glob paths to find.", minItems: 1 }),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files. Defaults to true." })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore. Defaults to true." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results, clamped to 1-200.", minimum: 1, maximum: 200 })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; default 5, clamped to 0.5..60.", minimum: 0.5, maximum: 60 })),
}, { additionalProperties: false });
export type FindToolInput = Static<typeof findSchema>;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60_000;
interface FindTarget { searchPath: string; pattern: string; exactPathInput: boolean; inputPath: string }
function normalizeLimit(limit: number | undefined): number { return limit === undefined || !Number.isFinite(limit) ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))); }
function normalizeTimeoutMs(timeout: number | undefined): number { return timeout === undefined || !Number.isFinite(timeout) ? DEFAULT_TIMEOUT_MS : Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(timeout * 1000))); }
function formatTimeoutSeconds(timeoutMs: number): string { const seconds = timeoutMs / 1000; return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1); }
async function resolveFindInternal(input: string, cwd: string, ctx?: InternalResourceContext): Promise<string> { const parsed = splitPathLikeGlob(input); if (!/^[a-z]+:\/\//i.test(parsed.basePath)) return input; for (const resolve of [ctx?.internalRouter?.resolve, ctx?.internalResourceRouter?.resolve, ctx?.resolveInternalUrl]) { const resolved = await resolve?.(parsed.basePath); if (typeof resolved === "string") return parsed.glob ? `${resolved}/${parsed.glob}` : resolved; } const fallback = resolveInternalSelector(parsed.basePath, cwd); return fallback ? parsed.glob ? `${fallback}/${parsed.glob}` : fallback : input; }
async function delimiterInExistingGlobRoot(value: string, cwd: string, ops: FindOperations): Promise<boolean> { const parsed = splitPathLikeGlob(value); return !!parsed.glob && /[;,\s]/.test(parsed.basePath) && await ops.exists(resolveToCwd(parsed.basePath, cwd)); }
async function expandDelimitedFindPaths(pathsValue: string[] | undefined, cwd: string, ops: FindOperations, ctx?: InternalResourceContext): Promise<string[]> {
	if (!pathsValue?.length) throw new Error("find.paths must include at least one path or glob."); const expanded: string[] = [];
	for (const input of pathsValue) { const raw = normalizePathLikeInput(input); if (raw === "") throw new Error("find.paths entries must not be empty."); const resolvedRaw = await resolveFindInternal(raw, cwd, ctx); const rawParsed = splitPathLikeGlob(resolvedRaw);
		if ((rawParsed.glob === undefined && await ops.exists(resolveToCwd(rawParsed.basePath, cwd))) || await delimiterInExistingGlobRoot(resolvedRaw, cwd, ops)) { expanded.push(resolvedRaw); continue; }
		const parts = await Promise.all(raw.split(/[;,\s]+/).map(normalizePathLikeInput).filter(Boolean).map((part) => resolveFindInternal(part, cwd, ctx)));
		const delimiterCanSplit = /[;,]/.test(raw) ? (await Promise.all(parts.map((part) => ops.exists(resolveToCwd(splitPathLikeGlob(part).basePath, cwd))))).some(Boolean) : (await Promise.all(parts.map((part) => ops.exists(resolveToCwd(splitPathLikeGlob(part).basePath, cwd))))).every(Boolean);
		if (parts.length > 1 && delimiterCanSplit) expanded.push(...parts); else expanded.push(resolvedRaw);
	}
	return expanded;
}
function normalizeFindTargets(cwd: string, pathsValue: string[] | undefined): FindTarget[] {
	if (!pathsValue || pathsValue.length === 0) throw new Error("find.paths must include at least one path or glob.");
	return pathsValue.map((searchPath) => {
		const parsed = splitPathLikeGlob(searchPath);
		const target = { searchPath: resolveToCwd(parsed.basePath, cwd), pattern: parsed.glob ?? "**/*", exactPathInput: parsed.glob === undefined, inputPath: searchPath };
		if (path.parse(target.searchPath).root === target.searchPath) throw new Error("Refusing to search filesystem root with find; provide a narrower path.");
		return target;
	});
}
function relativizeFoundPath(foundPath: string, searchPath: string): string {
	const hadTrailingSlash = foundPath.endsWith("/") || foundPath.endsWith("\\");
	let relativePath = path.relative(searchPath, foundPath);
	if (!relativePath) relativePath = path.basename(foundPath);
	if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
	return toPosixPath(relativePath);
}
function formatExactFoundPath(foundPath: string, cwd: string): string { return toPosixPath(path.relative(cwd, foundPath) || path.basename(foundPath)); }
function containsHiddenSegment(value: string): boolean { return toPosixPath(value).split("/").some((part) => part.startsWith(".") && part.length > 1); }
function findTargetMentionsNodeModules(target: FindTarget): boolean { return target.pattern.includes("node_modules") || toPosixPath(target.searchPath).split("/").includes("node_modules"); }
function formatFoundPath(foundPath: string, searchPath: string, searchPaths: string[], cwd: string): string {
	let absoluteFoundPath = path.isAbsolute(foundPath) ? foundPath : path.resolve(searchPath, foundPath);
	if (foundPath.endsWith("/") && !absoluteFoundPath.endsWith("/")) absoluteFoundPath += "/";
	const relative = relativizeFoundPath(absoluteFoundPath, searchPath);
	if (searchPaths.length <= 1) return relative;
	const rootLabel = toPosixPath(path.relative(cwd, searchPath) || path.basename(searchPath) || ".");
	return `${rootLabel}/${relative}`;
}
interface FindTreeNode {
	files: Set<string>;
	dirs: Map<string, FindTreeNode>;
}
function createFindTreeNode(): FindTreeNode { return { files: new Set(), dirs: new Map() }; }
function formatFindTree(relativized: string[]): string {
	const root = createFindTreeNode();
	for (const item of relativized) {
		const isDir = item.endsWith("/");
		const parts = item.replace(/\/+$/g, "").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		let node = root;
		const dirParts = isDir ? parts : parts.slice(0, -1);
		for (const dir of dirParts) {
			let child = node.dirs.get(dir);
			if (!child) {
				child = createFindTreeNode();
				node.dirs.set(dir, child);
			}
			node = child;
		}
		if (!isDir) node.files.add(parts[parts.length - 1]!);
	}
	const lines: string[] = [];
	const collapse = (dir: string, node: FindTreeNode): { label: string; node: FindTreeNode } => {
		const parts = [dir];
		let current = node;
		while (current.files.size === 0 && current.dirs.size === 1) {
			const [[nextDir, nextNode]] = [...current.dirs.entries()];
			parts.push(nextDir!);
			current = nextNode!;
		}
		return { label: parts.join("/"), node: current };
	};
	const render = (node: FindTreeNode, depth: number): void => {
		for (const file of [...node.files].sort()) lines.push(file);
		for (const [dir, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const folded = collapse(dir, child);
			lines.push(`${"#".repeat(depth + 1)} ${folded.label}/`);
			render(folded.node, depth + 1);
		}
	};
	render(root, 0);
	return lines.join("\n");
}
export interface FindToolDetails { truncation?: TruncationResult; resultLimitReached?: number; timedOut?: boolean; truncated?: boolean; skippedMissingPaths?: string[]; missingPaths?: string[]; scopePath?: string; fileCount?: number; files?: string[]; meta?: { limits?: { resultLimit?: number }; truncation?: TruncationResult } }
function buildFindResult(
	relativized: string[],
	effectiveLimit: number,
	timedOut: boolean,
	timeoutMs: number,
	skippedMissingPaths: string[] = [],
	resultLimitReached = false,
): {
	content: Array<{ type: "text"; text: string }>;
	details: FindToolDetails | undefined;
} {
	const rawOutput = relativized.length > 0 ? formatFindTree(relativized) : "No files found matching pattern";
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: FindToolDetails = { scopePath: ".", fileCount: relativized.length, files: relativized, meta: { limits: { resultLimit: effectiveLimit } } };
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Refine pattern or path to narrow results`);
		details.resultLimitReached = effectiveLimit;
	}
	if (timedOut) { notices.push(`find timed out after ${formatTimeoutSeconds(timeoutMs)}s; returning ${relativized.length} partial matches — increase timeout or narrow pattern`); details.timedOut = true; details.truncated = true; }
	if (skippedMissingPaths.length > 0) {
		notices.push(`Skipped missing paths: ${skippedMissingPaths.join(", ")}`);
		details.skippedMissingPaths = skippedMissingPaths;
		details.missingPaths = skippedMissingPaths;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
		details.meta = { ...(details.meta ?? {}), truncation };
		details.truncated = true;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: resultOutput }], details };
}
/** Pluggable operations for remote/container find backends. */
export interface FindOperations {
	stat?: (path: string) => Promise<{ isFile: boolean; isDirectory: boolean }> | { isFile: boolean; isDirectory: boolean } | undefined;
	exists: (path: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number; hidden: boolean }) => Promise<string[]> | string[];
}
const defaultFindOperations: FindOperations = {
	exists: pathExists,
	glob: () => [],
};
export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}
function stripTrailingForwardSlashes(value: string): string { let end = value.length; while (end > 0 && value[end - 1] === "/") end--; return value.slice(0, end); }

function formatFindCall(
	args: { paths?: string[]; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const paths = Array.isArray(args?.paths) ? args.paths.map((item) => splitPathLikeGlob(item).glob ? item : `${stripTrailingForwardSlashes(item)}/**/*`).join(", ") : "<paths>";
	let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", paths)}`;
	if (args?.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
	return text;
}
function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "Expand")}${theme.fg("muted", ")")}`;
		}
	}
	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	const timedOut = result.details?.timedOut;
	if (resultLimit || truncation?.truncated || timedOut) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (timedOut) warnings.push("timeout");
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}
export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: "Find filesystem paths by glob; use search when you need content matches instead of path matches.",
		promptSnippet: "Find filesystem paths by glob.",
		parameters: findSchema,
		async execute(
			_toolCallId,
			params: FindToolInput & { pattern?: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				const { limit, hidden, gitignore, timeout } = params;
				const paths = params.paths ?? (typeof params.pattern === "string" ? [params.pattern] : undefined);
				const resourceCtx = _ctx as InternalResourceContext | undefined;
				(async () => {
					try {
						const ops = customOps ?? defaultFindOperations;
						const targets = normalizeFindTargets(cwd, await expandDelimitedFindPaths(paths, cwd, ops, resourceCtx));
						const searchPaths = targets.map((target) => target.searchPath);
						const effectiveLimit = normalizeLimit(limit);
						const timeoutMs = normalizeTimeoutMs(timeout);
						const emitUpdate = (files: string[]) => _onUpdate?.({ content: [{ type: "text", text: files.join("\n") || "No files found matching pattern" }], details: { scopePath: ".", files, fileCount: files.length, truncated: false } });
						const exactFileResults: string[] = [];
						const searchableTargets: FindTarget[] = [];
						const skippedMissingPaths: string[] = [];
						for (const target of targets) {
							if (target.searchPath === path.parse(target.searchPath).root) throw new Error("Refusing to search filesystem root with find; provide a narrower path.");
							const stat = customOps ? await customOps.stat?.(target.searchPath) : await fsStat(target.searchPath).catch(() => undefined);
							if (!stat && targets.length > 1 && !customOps) {
								skippedMissingPaths.push(target.inputPath);
								continue;
							}
							if (!stat && targets.length === 1 && !customOps) {
								throw new Error(`ENOENT: Path not found: ${target.searchPath}`);
							}
							if (target.exactPathInput) {
								const isFile = typeof stat?.isFile === "function" ? stat.isFile() : stat?.isFile;
								if (isFile) {
									exactFileResults.push(formatExactFoundPath(target.searchPath, cwd));
									continue;
								}
							}
							searchableTargets.push(target);
						}
						if (exactFileResults.length > effectiveLimit || searchableTargets.length === 0) {
							const resultLimitReached = exactFileResults.length > effectiveLimit;
							settle(() => resolve(buildFindResult(exactFileResults.slice(0, effectiveLimit), effectiveLimit, false, timeoutMs, skippedMissingPaths, resultLimitReached)));
							emitUpdate(exactFileResults.slice(0, effectiveLimit));
							return;
						}
						if (customOps?.glob) {
							const deadline = Date.now() + timeoutMs;
							let timedOut = false;
							const relativized: string[] = [...exactFileResults];
							let customLimitReached = false;
							for (const target of searchableTargets) {
								if (!(await ops.exists(target.searchPath))) {
									if (targets.length > 1) {
										skippedMissingPaths.push(target.inputPath);
										continue;
									}
									settle(() => reject(new Error(`Path not found: ${target.searchPath}`)));
									return;
								}
								if (signal?.aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								const remaining = effectiveLimit - relativized.length;
								const remainingMs = deadline - Date.now();
								if (remaining <= 0) {
									const ignore = findTargetMentionsNodeModules(target) ? ["**/.git/**"] : ["**/node_modules/**", "**/.git/**"];
									const probe = await Promise.resolve(ops.glob(target.pattern, target.searchPath, { ignore, limit: 1, hidden: hidden !== false }));
									if (probe.some((p) => hidden !== false || !containsHiddenSegment(p))) customLimitReached = true;
									if (customLimitReached) break;
									continue;
								}
								if (remainingMs <= 0) {
									timedOut = true;
									break;
								}
								const timeoutResult = Symbol("find-timeout");
								let raceTimer: ReturnType<typeof setTimeout> | undefined;
								const ignore = findTargetMentionsNodeModules(target) ? ["**/.git/**"] : ["**/node_modules/**", "**/.git/**"];
								const results = await Promise.race<string[] | symbol>([
									Promise.resolve(ops.glob(target.pattern, target.searchPath, { ignore, limit: remaining + 1, hidden: hidden !== false })),
									new Promise<typeof timeoutResult>((resolveTimeout) => {
										raceTimer = setTimeout(() => resolveTimeout(timeoutResult), remainingMs);
									}),
								]);
								if (raceTimer) clearTimeout(raceTimer);
								if (!Array.isArray(results)) {
									timedOut = true;
									break;
								}
								if (target.exactPathInput && results.length === 0) { const stat = await customOps.stat?.(target.searchPath); if (!stat?.isDirectory) relativized.push(formatExactFoundPath(target.searchPath, cwd)); continue; }
								if (signal?.aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								const visible = results.filter((p) => hidden !== false || !containsHiddenSegment(p));
								if (visible.length > remaining) customLimitReached = true;
								relativized.push(...visible.slice(0, remaining).map((p) => formatFoundPath(p, target.searchPath, searchPaths, cwd)));
								emitUpdate(relativized);
								if (customLimitReached) break;
							}
							settle(() => resolve(buildFindResult(relativized, effectiveLimit, timedOut, timeoutMs, skippedMissingPaths, customLimitReached)));
							return;
						}
						const nativeBinding = loadNativeSearchBinding();
						if (nativeBinding) {
							const matches: { path: string; mtime: number }[] = exactFileResults.map((path) => ({ path, mtime: Number.POSITIVE_INFINITY }));
							let timedOut = false;
							const deadline = Date.now() + timeoutMs;
							for (const target of searchableTargets) {
								const remainingMs = deadline - Date.now();
								if (remainingMs <= 0) {
									timedOut = true;
									break;
								}
								try {
									const result = await nativeBinding.glob({
										pattern: target.pattern,
										path: target.searchPath,
										recursive: false,
										hidden: hidden !== false,
										gitignore: gitignore !== false,
										includeNodeModules: findTargetMentionsNodeModules(target),
										maxResults: effectiveLimit + 1,
										cache: false,
										sortByMtime: true,
										timeoutMs: remainingMs,
										signal,
									});
									matches.push(...result.matches.map((match) => { const fileType = match.fileType ?? (match as { file_type?: number }).file_type; const isDir = (fileType === 2 || fileType === "Dir" || (fileType === undefined && statSync(path.resolve(target.searchPath, match.path), { throwIfNoEntry: false })?.isDirectory())) && !match.path.endsWith("/"); const matchPath = isDir ? `${match.path}/` : match.path; return { path: formatFoundPath(matchPath, target.searchPath, searchPaths, cwd), mtime: match.mtime ?? 0 }; }));
									emitUpdate(matches.map((match) => match.path));
								} catch (error) {
									if (String(error).toLowerCase().includes("timed out")) {
										timedOut = true;
										break;
									}
									throw error;
								}
							}
							const uniqueMatches = [...matches.reduce((map, match) => { const previous = map.get(match.path); if (!previous || match.mtime > previous.mtime) map.set(match.path, match); return map; }, new Map<string, { path: string; mtime: number }>()).values()];
							uniqueMatches.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
							const resultLimitReached = uniqueMatches.length > effectiveLimit;
							settle(() => resolve(buildFindResult(uniqueMatches.slice(0, effectiveLimit).map((match) => match.path), effectiveLimit, timedOut, timeoutMs, skippedMissingPaths, resultLimitReached)));
							return;
						}
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}
						let timedOut = false;
						const relativized: string[] = [...exactFileResults];
						const deadline = Date.now() + timeoutMs;
						const runFdForTarget = async (target: FindTarget, remaining: number): Promise<boolean> => {
							const args: string[] = ["--glob", "--color=never", "--no-require-git", "--max-results", String(remaining + 1)];
							if (hidden !== false) args.push("--hidden");
							if (gitignore === false) args.push("--no-ignore");
							if (!findTargetMentionsNodeModules(target)) args.push("--exclude", "node_modules");
							let fdPattern = target.pattern;
							if (target.pattern.includes("/")) {
								args.push("--full-path");
								if (!target.pattern.startsWith("/") && !target.pattern.startsWith("**/") && target.pattern !== "**") fdPattern = `**/${target.pattern}`;
							}
							args.push("--", fdPattern, target.searchPath);
							const remainingMs = deadline - Date.now();
							if (remainingMs <= 0) {
								timedOut = true;
								return false;
							}
							return await new Promise<boolean>((resolveTarget, rejectTarget) => {
								const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
								const rl = createInterface({ input: child.stdout });
								let stderr = "";
								const lines: string[] = [];
								stopChild = () => {
									if (!child.killed) child.kill();
								};
								const targetTimer = setTimeout(() => {
									timedOut = true;
									stopChild?.();
								}, remainingMs);
								const cleanup = () => {
									clearTimeout(targetTimer);
									rl.close();
								};
								child.stderr?.on("data", (chunk) => {
									stderr += chunk.toString();
								});
								rl.on("line", (line) => lines.push(line));
								child.on("error", (error) => {
									cleanup();
									rejectTarget(new Error(`Failed to run fd: ${error.message}`));
								});
								child.on("close", (code) => {
									cleanup();
									if (signal?.aborted) {
										rejectTarget(new Error("Operation aborted"));
										return;
									}
									if (!timedOut && code !== 0 && lines.length === 0) {
										rejectTarget(new Error(stderr.trim() || `fd exited with code ${code}`));
										return;
									}
									for (const rawLine of lines.slice(0, remaining)) {
										const line = rawLine.replace(/\r$/, "").trim();
										if (line) { const found = statSync(path.resolve(target.searchPath, line), { throwIfNoEntry: false })?.isDirectory() && !line.endsWith("/") ? `${line}/` : line; relativized.push(formatFoundPath(found, target.searchPath, searchPaths, cwd)); }
									}
									emitUpdate(relativized);
									resolveTarget(lines.length > Math.max(0, remaining));
								});
							});
						};
						let resultLimitReached = false;
						for (const target of searchableTargets) {
							const remaining = effectiveLimit - relativized.length;
							if (timedOut) break;
							if (remaining <= 0) { if (await runFdForTarget(target, 0)) { resultLimitReached = true; break; } continue; }
							const targetLimitReached = await runFdForTarget(target, remaining);
							if (targetLimitReached) { resultLimitReached = true; break; }
						}
						settle(() => resolve(buildFindResult(relativized.slice(0, effectiveLimit), effectiveLimit, timedOut, timeoutMs, skippedMissingPaths, resultLimitReached)));
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result, options, theme, context.showImages));
			return text;
		},
	};
}
export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
