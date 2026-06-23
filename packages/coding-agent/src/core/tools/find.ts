import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { splitPathLikeGlob } from "./glob-path-utils.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.Optional(
		Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts' (default: '**')",
		}),
	),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	paths: Type.Optional(
		Type.Union([
			Type.String({ description: "Directory to search in" }),
			Type.Array(Type.String({ description: "Directories to search in" })),
		]),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default/max: 200)", minimum: 1, maximum: 200 })),
	hidden: Type.Optional(Type.Boolean({ description: "Compatibility option. Hidden files are included by default." })),
	gitignore: Type.Optional(
		Type.Boolean({ description: "Compatibility option. .gitignore is respected by default." }),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 5, clamped to 0.5..60)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60_000;

interface FindTarget {
	searchPath: string;
	pattern: string;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function normalizeTimeoutMs(timeout: number | undefined): number {
	if (timeout === undefined || !Number.isFinite(timeout)) return DEFAULT_TIMEOUT_MS;
	return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(timeout * 1000)));
}

function formatTimeoutSeconds(timeoutMs: number): string {
	const seconds = timeoutMs / 1000;
	return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

function normalizeSearchPaths(pathValue: string | undefined, pathsValue: string | string[] | undefined): string[] {
	if (Array.isArray(pathsValue)) return pathsValue.length > 0 ? pathsValue : [pathValue ?? "."];
	return [pathValue ?? pathsValue ?? "."];
}

function normalizeFindTargets(
	cwd: string,
	pathValue: string | undefined,
	pathsValue: string | string[] | undefined,
	pattern: string | undefined,
): FindTarget[] {
	return normalizeSearchPaths(pathValue, pathsValue).map((searchPath) => {
		if (pattern !== undefined) return { searchPath: resolveToCwd(searchPath, cwd), pattern };
		const parsed = splitPathLikeGlob(searchPath);
		return { searchPath: resolveToCwd(parsed.basePath, cwd), pattern: parsed.glob ?? "**" };
	});
}

function relativizeFoundPath(foundPath: string, searchPath: string): string {
	const hadTrailingSlash = foundPath.endsWith("/") || foundPath.endsWith("\\");
	let relativePath = foundPath;
	if (foundPath.startsWith(searchPath)) {
		relativePath = foundPath.slice(searchPath.length + 1);
	} else {
		relativePath = path.relative(searchPath, foundPath);
	}
	if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
	return toPosixPath(relativePath);
}

function closestSearchPath(foundPath: string, searchPaths: string[]): string {
	return searchPaths
		.filter((searchPath) => foundPath.startsWith(searchPath))
		.sort((a, b) => b.length - a.length)[0] ?? searchPaths[0] ?? ".";
}

function formatFoundPath(foundPath: string, searchPath: string, searchPaths: string[], cwd: string): string {
	const relative = relativizeFoundPath(foundPath, searchPath);
	if (searchPaths.length <= 1) return relative;
	const rootLabel = toPosixPath(path.relative(cwd, searchPath) || path.basename(searchPath) || ".");
	return `${rootLabel}/${relative}`;
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	timedOut?: boolean;
	truncated?: boolean;
}

function buildFindResult(
	relativized: string[],
	effectiveLimit: number,
	timedOut: boolean,
	timeoutMs: number,
): {
	content: Array<{ type: "text"; text: string }>;
	details: FindToolDetails | undefined;
} {
	const resultLimitReached = relativized.length >= effectiveLimit;
	const rawOutput = relativized.length > 0 ? relativized.join("\n") : "No files found matching pattern";
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Refine pattern or path to narrow results`);
		details.resultLimitReached = effectiveLimit;
	}
	if (timedOut) {
		notices.push(
			`find timed out after ${formatTimeoutSeconds(timeoutMs)}s; returning ${relativized.length} partial matches — increase timeout or narrow pattern`,
		);
		details.timedOut = true;
		details.truncated = true;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
		details.truncated = true;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text", text: resultOutput }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

function formatFindCall(
	args: { pattern?: string; path?: string; paths?: string | string[]; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string {
	const pattern = str(args?.pattern ?? "**");
	const rawPaths = Array.isArray(args?.paths) ? args.paths.join(", ") : args?.paths;
	const rawPath = str(args?.path ?? rawPaths);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
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
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results (default/max) or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				paths,
				limit,
				hidden,
				gitignore,
				timeout,
			}: {
				pattern?: string;
				path?: string;
				paths?: string | string[];
				limit?: number;
				hidden?: boolean;
				gitignore?: boolean;
				timeout?: number;
			},

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
				let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					if (timeoutTimer) clearTimeout(timeoutTimer);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const targets = normalizeFindTargets(cwd, searchDir, paths, pattern);
						const searchPaths = targets.map((target) => target.searchPath);
						const targetPatterns = Array.from(new Set(targets.map((target) => target.pattern)));
						const effectivePattern = targetPatterns.length === 1 ? targetPatterns[0]! : `{${targetPatterns.join(",")}}`;
						const effectiveLimit = normalizeLimit(limit);
						const timeoutMs = normalizeTimeoutMs(timeout);
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							const deadline = Date.now() + timeoutMs;
							let timedOut = false;
							const relativized: string[] = [];
							for (const target of targets) {
								if (!(await ops.exists(target.searchPath))) {
									settle(() => reject(new Error(`Path not found: ${target.searchPath}`)));
									return;
								}
								if (signal?.aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								const remaining = effectiveLimit - relativized.length;
								const remainingMs = deadline - Date.now();
								if (remaining <= 0) break;
								if (remainingMs <= 0) {
									timedOut = true;
									break;
								}
								const timeoutResult = Symbol("find-timeout");
								let raceTimer: ReturnType<typeof setTimeout> | undefined;
								const results = await Promise.race<string[] | symbol>([
									Promise.resolve(
										ops.glob(target.pattern, target.searchPath, {
											ignore: ["**/node_modules/**", "**/.git/**"],
											limit: remaining,
										}),
									),
									new Promise<typeof timeoutResult>((resolveTimeout) => {
										raceTimer = setTimeout(() => resolveTimeout(timeoutResult), remainingMs);
									}),
								]);
								if (raceTimer) clearTimeout(raceTimer);
								if (!Array.isArray(results)) {
									timedOut = true;
									break;
								}
								if (signal?.aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								relativized.push(...results.map((p) => formatFoundPath(p, target.searchPath, searchPaths, cwd)));
							}
							settle(() => resolve(buildFindResult(relativized, effectiveLimit, timedOut, timeoutMs)));
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						// Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore
						// semantics whether or not the search path is inside a git repository, without
						// leaking sibling-directory rules the way --ignore-file (a global source) would.
						const args: string[] = ["--glob", "--color=never", "--no-require-git", "--max-results", String(effectiveLimit)];
						if (hidden !== false) args.push("--hidden");
						if (gitignore === false) args.push("--no-ignore");

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let fdPattern = effectivePattern;
						if (effectivePattern.includes("/")) {
							args.push("--full-path");
							if (!effectivePattern.startsWith("/") && !effectivePattern.startsWith("**/") && effectivePattern !== "**") {
								fdPattern = `**/${effectivePattern}`;
							}
						}
						args.push("--", fdPattern, ...searchPaths);

						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let timedOut = false;
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};
						timeoutTimer = setTimeout(() => {
							timedOut = true;
							stopChild?.();
						}, timeoutMs);

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const output = lines.join("\n");
							if (!timedOut && code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const matchingSearchPath = closestSearchPath(line, searchPaths);
								relativized.push(formatFoundPath(line, matchingSearchPath, searchPaths, cwd));
							}

							settle(() => resolve(buildFindResult(relativized, effectiveLimit, timedOut, timeoutMs)));
						});
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
