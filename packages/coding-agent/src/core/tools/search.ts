import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolOptions,
} from "./grep.ts";
import { splitPathLikeGlob } from "./glob-path-utils.ts";
import { invalidArgText, shortenPath, str } from "./render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const searchSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	paths: Type.Optional(
		Type.Union([
			Type.String({ description: "Directory or file to search" }),
			Type.Array(Type.String({ description: "Directory or file to search" })),
		]),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	i: Type.Optional(Type.Boolean({ description: "Alias for ignoreCase" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	skip: Type.Optional(Type.Number({ description: "File-page offset for multi-file search results (default: 0)" })),
	gitignore: Type.Optional(
		Type.Boolean({ description: "Compatibility option. The underlying search respects .gitignore by default." }),
	),
});

export type SearchToolInput = Static<typeof searchSchema>;
export type SearchToolDetails = GrepToolDetails;
export type SearchToolOptions = GrepToolOptions;

function normalizePaths(pathValue: string | undefined, pathsValue: string | string[] | undefined): string[] {
	if (Array.isArray(pathsValue)) return pathsValue.length > 0 ? pathsValue : [pathValue ?? "."];
	return [pathsValue ?? pathValue ?? "."];
}

interface SearchTarget {
	path: string;
	glob?: string;
}

interface SearchOutputGroup {
	path: string;
	lines: string[];
}

const DEFAULT_LIMIT = 100;
const INTERNAL_SKIP_LIMIT = 2000;

function normalizeSkip(skip: number | undefined): number {
	if (skip === undefined) return 0;
	if (!Number.isFinite(skip) || skip < 0) throw new Error("Skip must be a non-negative number");
	return Math.floor(skip);
}

function normalizeSearchTargets(
	pathValue: string | undefined,
	pathsValue: string | string[] | undefined,
	glob: string | undefined,
): SearchTarget[] {
	return normalizePaths(pathValue, pathsValue).map((searchPath) => {
		const parsed = splitPathLikeGlob(searchPath);
		return { path: parsed.basePath, glob: parsed.glob ?? glob };
	});
}

function countMatchLines(text: string): number {
	return text.split("\n").filter((line) => /^.+:\d+: /.test(line) && !/^.+-\d+- /.test(line)).length;
}

function groupSearchOutput(text: string): SearchOutputGroup[] {
	const groups: SearchOutputGroup[] = [];
	let current: SearchOutputGroup | undefined;
	for (const line of text.split("\n")) {
		const match = line.match(/^(.+?)(?::\d+: |-\d+- )/);
		if (!match) continue;
		const filePath = match[1]!;
		if (!current || current.path !== filePath) {
			current = { path: filePath, lines: [] };
			groups.push(current);
		}
		current.lines.push(line);
	}
	return groups;
}

function formatSearchGroups(groups: SearchOutputGroup[], limit: number): string {
	const lines: string[] = [];
	let remaining = limit;
	for (const group of groups) {
		for (const line of group.lines) {
			const isMatchLine = /^.+:\d+: /.test(line) && !/^.+-\d+- /.test(line);
			if (isMatchLine) {
				if (remaining <= 0) return lines.join("\n");
				remaining--;
			}
			lines.push(line);
		}
	}
	return lines.join("\n");
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
	const grepDefinition = createGrepToolDefinition(cwd, options);
	return {
		...grepDefinition,
		name: "search",
		label: "search",
		description:
			"Search file contents for a pattern. Compatibility wrapper around grep that returns matching lines with file paths and line numbers, respects .gitignore, and accepts path or paths.",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: searchSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const targets = normalizeSearchTargets(params.path, params.paths, params.glob);
			const ignoreCase = params.ignoreCase ?? params.i;
			const limit = params.limit ?? DEFAULT_LIMIT;
			const skip = normalizeSkip(params.skip);
			const results = [];
			const groups: SearchOutputGroup[] = [];
			let remaining = limit;
			for (const target of targets) {
				if (skip === 0 && remaining <= 0) break;
				const result = await grepDefinition.execute(
					toolCallId,
					{
						pattern: params.pattern,
						path: target.path,
						glob: target.glob,
						ignoreCase,
						literal: params.literal,
						context: params.context,
						limit: skip > 0 ? INTERNAL_SKIP_LIMIT : remaining,
						gitignore: params.gitignore,
					},
					signal,
					onUpdate,
					ctx,
				);
				results.push(result);
				const text = result.content
					.map((item) => (item.type === "text" ? item.text : undefined))
					.filter((text): text is string => typeof text === "string")
					.join("\n");
				if (skip > 0) groups.push(...groupSearchOutput(text));
				else remaining -= countMatchLines(text);
			}

			const details: SearchToolDetails = {};
			for (const result of results) {
				if (result.details?.truncation) details.truncation = result.details.truncation;
				if (result.details?.matchLimitReached) details.matchLimitReached = result.details.matchLimitReached;
				if (result.details?.linesTruncated) details.linesTruncated = true;
			}

			if (skip > 0) {
				const output = formatSearchGroups(groups.slice(skip), limit) || `No more results (skip=${skip})`;
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				let content = truncation.content;
				if (truncation.truncated) {
					details.truncation = truncation;
					content += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} combined output limit reached]`;
				}
				return {
					content: [{ type: "text", text: content }],
					details: Object.keys(details).length > 0 ? details : undefined,
				};
			}

			if (results.length === 1) return results[0]!;

			const content = results
				.map((result, index) => {
					const text = result.content
						.map((item) => (item.type === "text" ? item.text : undefined))
						.filter((text): text is string => typeof text === "string" && text.length > 0)
						.join("\n");
					return `# ${targets[index]?.path ?? "."}\n${text}`;
				})
				.join("\n\n");
			const truncation = truncateHead(content, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				output += `\n\n[${formatSize(DEFAULT_MAX_BYTES)} combined output limit reached]`;
			}
			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
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
