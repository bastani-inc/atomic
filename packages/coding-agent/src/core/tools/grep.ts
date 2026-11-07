import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { parenthesizedKeyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import type { ManagedToolError } from "../../utils/managed-tool-errors.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { loadNativeSearchBinding, type NativeGrepMatch } from "./search-native.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object(
	{
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(
			Type.String({
				description:
					"Filter files by glob pattern, relative to path, e.g. '*.ts', 'src/**/*.ts' or '**/*.spec.ts'. A pattern without '/' matches file names at any depth",
			}),
		),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		type: Type.Optional(Type.String({ description: "File type filter for native grep." })),
		literal: Type.Optional(
			Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
		),
		context: Type.Optional(
			Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
		),
		contextBefore: Type.Optional(Type.Number({ description: "Lines to show before each match." })),
		contextAfter: Type.Optional(Type.Number({ description: "Lines to show after each match." })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
		offset: Type.Optional(Type.Number({ description: "Skip first N matches." })),
		mode: Type.Optional(
			Type.Union([Type.Literal("content"), Type.Literal("count"), Type.Literal("filesWithMatches")]),
		),
		maxCountPerFile: Type.Optional(Type.Number({ description: "Maximum matches per file." })),
		hidden: Type.Optional(Type.Boolean({ description: "Search hidden files (default true)." })),
		cache: Type.Optional(Type.Boolean({ description: "Use native cache." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Native grep timeout in milliseconds." })),
		gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore files (default: true)" })),
	},
	{ additionalProperties: false },
);

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

type RipgrepText = { text?: unknown; bytes?: unknown };

type RipgrepLineEvent = {
	type: "match" | "context";
	data?: {
		path?: RipgrepText;
		line_number?: unknown;
		lines?: RipgrepText;
	};
};

function isRipgrepLineEvent(event: unknown): event is RipgrepLineEvent {
	return (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		(event.type === "match" || event.type === "context")
	);
}

/** Decode a ripgrep JSON text field (path or line). Non-UTF-8 data arrives base64-encoded in `bytes`. */
function decodeRgText(data: RipgrepText | undefined): string {
	if (typeof data?.text === "string") return data.text;
	if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf-8");
	return "";
}

/** Clamp a line count so String() never yields exponent notation, which rg rejects. */
function clampLineCount(value: number | undefined): number {
	return value !== undefined && value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * Pluggable operations for the grep tool.
 * The search itself always runs ripgrep or the native search locally; to search a remote system, override the tool's execute().
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
	/** Enable shared native filesystem scan cache. Defaults to false; search callers also disable it to stay fresh across out-of-band filesystem mutations. */
	nativeCache?: boolean;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text +=
				theme.fg("muted", "\n... ") + parenthesizedKeyHint("app.tools.expand", "Expand", `${remaining} more lines`);
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function formatNativeGrepMatch(match: NativeGrepMatch, displayPath: string): string[] {
	// Lines are split only at LF, like ripgrep; a lone CR stays inside a line and is dropped from the display.
	const clean = (line: string) => line.replace(/\r/g, "");
	const lines: string[] = [];
	for (const contextLine of match.contextBefore ?? []) {
		lines.push(`${displayPath}-${contextLine.lineNumber}- ${clean(contextLine.line)}`);
	}
	lines.push(`${displayPath}:${match.lineNumber}: ${clean(match.line)}`);
	for (const contextLine of match.contextAfter ?? []) {
		lines.push(`${displayPath}-${contextLine.lineNumber}- ${clean(contextLine.line)}`);
	}
	return lines;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
				gitignore,
				type,
				contextBefore,
				contextAfter,
				offset,
				mode,
				maxCountPerFile,
				hidden,
				cache,
				timeoutMs,
			}: GrepToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const executionCwd = ctx?.cwd || cwd;
						const searchPath = resolveToCwd(searchDir || ".", executionCwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = clampLineCount(context);
						const contextBeforeValue = contextBefore === undefined ? contextValue : clampLineCount(contextBefore);
						const contextAfterValue = contextAfter === undefined ? contextValue : clampLineCount(contextAfter);
						const nativeCache = options?.nativeCache === true;
						const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
						const relativeGlob = glob?.replace(/^(!?)(?:\.\/)+/, "$1");
						const formatPath = (filePath: string): string =>
							isDirectory ? path.normalize(filePath).replace(/\\/g, "/") : path.basename(filePath);

						if (!customOps && !literal) {
							const nativeBinding = loadNativeSearchBinding();
							if (nativeBinding) {
								const nativeResult = await nativeBinding.grep({
									pattern,
									path: searchPath,
									cwd: executionCwd,
									glob: relativeGlob,
									ignoreCase,
									hidden: hidden ?? true,
									gitignore: gitignore !== false,
									cache: cache ?? nativeCache,
									maxCount: mode === "count" ? undefined : effectiveLimit + 1,
									offset,
									context:
										contextBefore === undefined && contextAfter === undefined ? contextValue : undefined,
									contextBefore,
									contextAfter,
									type,
									mode,
									maxCountPerFile,
									maxColumns: GREP_MAX_LINE_LENGTH,
									multiline: pattern.includes("\n") || pattern.includes("\\n"),
									signal,
									timeoutMs: timeoutMs ?? 30_000,
								});
								if (nativeResult.error) throw new Error(nativeResult.error);
								if (nativeResult.matches.length === 0) {
									settle(() =>
										resolve({
											content: [{ type: "text", text: mode === "count" ? "0" : "No matches found" }],
											details: undefined,
										}),
									);
									return;
								}
								const visibleMatches = nativeResult.matches.slice(0, effectiveLimit);
								const filesOutput =
									mode === "filesWithMatches" && !isDirectory && (offset ?? 0) > 0
										? ""
										: visibleMatches.map((match) => formatPath(match.path)).join("\n");
								const countOutput = String(Math.max(0, nativeResult.totalMatches - (offset ?? 0)));
								const rawOutput =
									mode === "count"
										? countOutput
										: mode === "filesWithMatches"
											? filesOutput || "No matches found"
											: visibleMatches
													.flatMap((match) => formatNativeGrepMatch(match, formatPath(match.path)))
													.join("\n");
								const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
								let output = truncation.content;
								const details: GrepToolDetails = {};
								const notices: string[] = [];
								if (nativeResult.matches.length > effectiveLimit || nativeResult.limitReached) {
									notices.push(
										`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
									);
									details.matchLimitReached = effectiveLimit;
								}
								if (truncation.truncated) {
									notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
									details.truncation = truncation;
								}
								if (visibleMatches.some((match) => match.truncated)) {
									notices.push(
										`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
									);
									details.linesTruncated = true;
								}
								if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
								settle(() =>
									resolve({
										content: [{ type: "text", text: output }],
										details: Object.keys(details).length > 0 ? details : undefined,
									}),
								);
								return;
							}
						}

						let downloadFailure: ManagedToolError | undefined;
						const rgPath = await ensureTool("rg", (status) => {
							downloadFailure = status.error;
						});
						if (!rgPath) {
							const failure =
								downloadFailure ?? new Error("ripgrep (rg) is not available and could not be downloaded");
							settle(() => reject(failure));
							return;
						}

						const args: string[] = ["--no-config", "--json", "--line-number", "--color=never"];
						if (hidden !== false) args.push("--hidden");
						if (gitignore === false) args.push("--no-ignore");
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (pattern.includes("\n") || pattern.includes("\\n")) args.push("--multiline");
						if (type) args.push("--type", type);
						if (maxCountPerFile !== undefined) args.push("--max-count", String(maxCountPerFile));
						if (relativeGlob) args.push("--glob", relativeGlob);
						const contentMode = mode !== "count" && mode !== "filesWithMatches";
						// rg emits the surrounding lines as `context` events, so no matched file is ever read here (pi #9276).
						if (contentMode && contextBeforeValue > 0) args.push("--before-context", String(contextBeforeValue));
						if (contentMode && contextAfterValue > 0) args.push("--after-context", String(contextAfterValue));
						args.push("--", pattern, isDirectory ? "." : searchPath);

						const child = spawn(rgPath, args, {
							cwd: isDirectory ? searchPath : undefined,
							env: createChildProcessEnvironment(),
							stdio: ["ignore", "pipe", "pipe"],
						});
						const timeoutTimer = timeoutMs !== undefined ? setTimeout(() => stopChild(), timeoutMs) : undefined;
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							if (timeoutTimer) clearTimeout(timeoutTimer);
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Size of the full output, including lines past the byte cap that are counted but not stored.
						let outputBytes = 0;
						let outputLineCount = 0;
						const pushLine = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean) => {
							const relativePath = formatPath(filePath);
							// Lines are split only at LF, like ripgrep; a CR inside a line is dropped from the display,
							// as in the native search.
							const sanitized = lineText.replace(/\r/g, "").replace(/\n$/, "");
							// Truncate long lines so grep output stays compact.
							const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) linesTruncated = true;
							const line = isMatch
								? `${relativePath}:${lineNumber}: ${truncatedText}`
								: `${relativePath}-${lineNumber}- ${truncatedText}`;
							// Byte truncation below drops everything past the cap, so keep counting but stop storing (pi #9276).
							// outputBytes counts a newline after every line; the joined output has one fewer.
							if (outputBytes - 1 <= DEFAULT_MAX_BYTES) outputLines.push(line);
							outputBytes += Buffer.byteLength(line, "utf-8") + 1;
							outputLineCount++;
						};

						let lastShown: { filePath: string; lineNumber: number } | undefined;
						let pendingContext: Array<{ filePath: string; lineNumber: number; lineText: string }> = [];
						let pendingContextStart = 0;
						const bufferContext = (filePath: string, lineNumber: number, lineText: string) => {
							if (pendingContext.at(-1)?.filePath !== filePath) {
								pendingContext = [];
								pendingContextStart = 0;
							}
							pendingContext.push({ filePath, lineNumber, lineText });
							while (
								pendingContextStart < pendingContext.length &&
								pendingContext[pendingContextStart].lineNumber <= lineNumber - contextBeforeValue
							) {
								pendingContextStart++;
							}
							if (pendingContextStart * 2 >= pendingContext.length) {
								pendingContext = pendingContext.slice(pendingContextStart);
								pendingContextStart = 0;
							}
						};
						// Set at the last allowed match. rg still sends that match's trailing context, which is kept,
						// and the limit notice waits for proof of one more match.
						let limitHit = false;
						let done = false;
						let seenMatches = 0,
							seenFiles = 0;
						const seenFilePaths = new Set<string>(),
							filesWithMatches = new Set<string>();
						const finish = () => {
							done = true;
							stopChild(true);
						};
						const onContentLine = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean) => {
							const trailingEnd = (lastShown?.lineNumber ?? 0) + contextAfterValue;
							const inTrailingWindow = filePath === lastShown?.filePath && lineNumber <= trailingEnd;
							if (limitHit) {
								// A match inside the last match's trailing context is shown as context.
								if (inTrailingWindow) pushLine(filePath, lineNumber, lineText, false);
								// Only another match proves that the limit cut results off.
								if (isMatch) matchLimitReached = true;
								if (matchLimitReached && !(inTrailingWindow && lineNumber < trailingEnd)) finish();
								return;
							}
							if (!isMatch) {
								if (inTrailingWindow) pushLine(filePath, lineNumber, lineText, false);
								else bufferContext(filePath, lineNumber, lineText);
								return;
							}
							seenMatches++;
							if (offset !== undefined && seenMatches <= offset) {
								bufferContext(filePath, lineNumber, lineText);
								return;
							}
							for (let index = pendingContextStart; index < pendingContext.length; index++) {
								const entry = pendingContext[index];
								if (entry.filePath === filePath && entry.lineNumber >= lineNumber - contextBeforeValue) {
									pushLine(entry.filePath, entry.lineNumber, entry.lineText, false);
								}
							}
							pendingContext = [];
							pendingContextStart = 0;
							pushLine(filePath, lineNumber, lineText, true);
							lastShown = { filePath, lineNumber };
							matchCount++;
							if (matchCount >= effectiveLimit) limitHit = true;
						};

						rl.on("line", (line) => {
							if (done || !line.trim() || (mode === "filesWithMatches" && matchCount >= effectiveLimit)) return;
							let event: unknown;
							try {
								event = JSON.parse(line) as unknown;
							} catch {
								return;
							}
							if (!isRipgrepLineEvent(event)) return;
							const filePath = decodeRgText(event.data?.path);
							const lineNumber = event.data?.line_number;
							if (!filePath || typeof lineNumber !== "number") return;
							if (contentMode) {
								onContentLine(filePath, lineNumber, decodeRgText(event.data?.lines), event.type === "match");
								return;
							}
							if (event.type !== "match") return;
							if (mode === "filesWithMatches") {
								const formatted = formatPath(filePath);
								if (!seenFilePaths.has(formatted)) {
									seenFilePaths.add(formatted);
									seenFiles++;
									if (offset === undefined || seenFiles > offset) filesWithMatches.add(formatted);
								}
								matchCount = filesWithMatches.size;
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
								return;
							}
							matchCount++;
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: mode === "count" ? "0" : "No matches found" }],
										details: undefined,
									}),
								);
								return;
							}
							if (mode === "count" || mode === "filesWithMatches") {
								settle(() =>
									resolve({
										content: [
											{
												type: "text",
												text:
													mode === "count"
														? String(Math.max(0, matchCount - (offset ?? 0)))
														: [...filesWithMatches].join("\n") || "No matches found",
											},
										],
										details: matchLimitReached ? { matchLimitReached: effectiveLimit } : undefined,
									}),
								);
								return;
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							truncation.totalLines = outputLineCount;
							truncation.totalBytes = outputBytes - 1;
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
