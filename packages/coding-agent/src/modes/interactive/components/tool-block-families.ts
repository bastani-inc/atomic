import { sep } from "node:path";
import { type Component, getImageDimensions, truncateToWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import { savedReadLines } from "../../../core/storage/session/saved-read-summary.js";
import type { WaitOutcome } from "../../../core/tasks/contracts.js";
import { generateDiffString } from "../../../core/tools/edit-diff.ts";
import { splitReadLineSelector } from "../../../core/tools/read-selectors.ts";
import { formatReadLineRange, linkPath, replaceTabs } from "../../../core/tools/render-utils.ts";
import {
	EMPTY_OUTPUT_TEXT,
	presentTaskError,
	waitResultTail,
	waitStatus,
} from "../../../core/tools/shell-task-status.ts";
import {
	displayTodoId,
	formatTodoId,
	getTodoStatus,
	getTodoTitle,
	isTodoClosed,
	normalizeTodoId,
	splitTodosByAssignment,
} from "../../../core/tools/todos-model.ts";
import type { TodoFrontMatter, TodoRecord, TodoToolDetails } from "../../../core/tools/todos-types.ts";
import type { TruncationResult } from "../../../core/tools/truncate.ts";
import { getCwdRelativePath, resolvePath, shortenHomePath } from "../../../utils/paths.ts";
import { singleLineDisplayText, terminalDisplayText } from "../../../utils/terminal-text.ts";
import { type CodeHighlighter, getLanguageFromPath, highlightCode, type Theme, theme } from "../theme/theme.js";
import { slashCommandHint } from "./nav-keys.ts";
import { collapseToolBlockLines, TOOL_BLOCK_LIMITS, ToolBlockRecords, type ToolBlockStatus } from "./tool-block.ts";
import { formatWorkingElapsed } from "./working-run-meter.ts";

export interface BuiltinToolBlockContentPart {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
}

export interface BuiltinToolBlockResult {
	readonly content: readonly BuiltinToolBlockContentPart[];
	readonly details?: unknown;
	readonly isError: boolean;
	readonly durationMs?: number;
}

export interface BuiltinToolBlockInput {
	readonly toolName: string;
	readonly args: unknown;
	readonly result?: BuiltinToolBlockResult;
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly elapsedMs?: number;
	readonly highlighter?: CodeHighlighter;
	readonly theme?: Pick<Theme, "fg" | "bold">;
	readonly canManageTask?: (taskId: string) => boolean;
}

export interface BuiltinToolBlockPresentation {
	readonly title: string;
	readonly args?: string;
	readonly meta?: readonly string[];
	readonly details?: Component;
	readonly status?: ToolBlockStatus;
}

class ToolBlockLines implements Component {
	private readonly lines: readonly string[];
	private readonly wrap: boolean;

	constructor(lines: readonly string[], wrap = false) {
		this.lines = lines;
		this.wrap = wrap;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1 || this.lines.length === 0) return [];
		if (!this.wrap) {
			return this.lines.map((line) => truncateToWidth(line, width, "…"));
		}
		return this.lines.flatMap((line) =>
			wrapTextWithAnsi(line, width).map((part) => truncateToWidth(part, width, "…")),
		);
	}
}

class GutteredToolBlockLines implements Component {
	private readonly entries: readonly { readonly lineNumber: number; readonly body: string }[];
	private readonly gutterWidth: number;
	private readonly activeTheme: Pick<Theme, "fg" | "bold">;

	constructor(
		entries: readonly { readonly lineNumber: number; readonly body: string }[],
		gutterWidth: number,
		activeTheme: Pick<Theme, "fg" | "bold"> = theme,
	) {
		this.entries = entries;
		this.gutterWidth = gutterWidth;
		this.activeTheme = activeTheme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1 || this.entries.length === 0) return [];
		const prefixWidth = this.gutterWidth + 2;
		if (width <= prefixWidth) {
			return this.entries.flatMap(({ lineNumber, body }) => {
				const gutter = this.activeTheme.fg("dim", String(lineNumber).padStart(this.gutterWidth, " "));
				return wrapTextWithAnsi(`${gutter}  ${body}`, width).map((part) => truncateToWidth(part, width, "…"));
			});
		}
		const bodyWidth = Math.max(1, width - prefixWidth);
		const continuationPad = " ".repeat(prefixWidth);
		const out: string[] = [];
		for (const { lineNumber, body } of this.entries) {
			const gutter = this.activeTheme.fg("dim", String(lineNumber).padStart(this.gutterWidth, " "));
			const wrapped = wrapTextWithAnsi(body, bodyWidth);
			if (wrapped.length === 0) {
				out.push(truncateToWidth(`${gutter}  `, width, "…"));
				continue;
			}
			for (let index = 0; index < wrapped.length; index++) {
				const prefix = index === 0 ? `${gutter}  ` : continuationPad;
				out.push(truncateToWidth(`${prefix}${wrapped[index]!}`, width, "…"));
			}
		}
		return out;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractRawText(result: BuiltinToolBlockResult | undefined): string {
	if (!result) return "";
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => terminalDisplayText(part.text ?? ""))
		.join("\n")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "");
}

function trimTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}

function splitContentLines(text: string): string[] {
	const trimmed = trimTrailingNewlines(text);
	return trimmed === "" ? [] : trimmed.split("\n");
}

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

export function formatToolBlockPath(rawPath: string, cwd: string): string {
	const cleaned = singleLineDisplayText(rawPath).trim();
	if (!cleaned) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) && !cleaned.toLowerCase().startsWith("file://")) {
		return cleaned;
	}
	const cwdRel = getCwdRelativePath(cleaned, cwd);
	if (cwdRel !== undefined) return toPosix(cwdRel);
	const resolved = resolvePath(cleaned, cwd);
	return toPosix(shortenHomePath(resolved));
}

export function stripUrlScheme(rawUrl: string): string {
	return singleLineDisplayText(rawUrl)
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

export function formatToolBlockByteSize(bytes: number): string {
	const safe = Math.max(0, Math.floor(bytes));
	if (safe < 1024) return `${safe} B`;
	if (safe < 1024 * 1024) {
		const kb = Math.round((safe / 1024) * 10) / 10;
		return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`;
	}
	const mb = Math.round((safe / (1024 * 1024)) * 10) / 10;
	return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function formatToolBlockElapsed(
	ms: number | undefined,
	options: { isRunning: boolean; subTenDecimal: boolean },
): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
	if (options.isRunning) {
		return ms >= 1000 ? formatWorkingElapsed(ms) : undefined;
	}
	if (options.subTenDecimal) {
		if (ms < 10_000) {
			const tenths = Math.max(1, Math.round(ms / 100)) / 10;
			return `${tenths.toFixed(1)}s`;
		}
		return formatWorkingElapsed(ms);
	}
	return ms >= 1000 ? formatWorkingElapsed(ms) : undefined;
}

function resolveDurationMs(input: BuiltinToolBlockInput): number | undefined {
	const details = asRecord(input.result?.details);
	return (
		asNumber(input.result?.durationMs) ??
		asNumber(details?.wallTimeMs) ??
		asNumber(asRecord(details?.summary)?.durationMs) ??
		asNumber(input.elapsedMs)
	);
}

function isRejectedResult(input: BuiltinToolBlockInput): boolean {
	const result = input.result;
	if (!result?.isError) return false;
	const details = asRecord(result.details);
	if (details?.rejected === true || details?.status === "rejected") return true;
	if (details?.rejected === false || input.executionStarted || details?.exitCode !== undefined) return false;
	const text = extractRawText(result).trim();
	return /^(?:(?:permission|tool call|action)\s+(?:was\s+)?(?:rejected|declined)\s+by\s+user|user\s+(?:rejected|declined)(?:\s+(?:permission|tool call|action))?)\.?$/i.test(
		text,
	);
}

function isWaitingForApproval(input: BuiltinToolBlockInput): boolean {
	if (input.result && !input.isPartial) return false;
	const details = asRecord(input.result?.details);
	return details?.waitingForApproval === true;
}

function isInterruptedResult(result: BuiltinToolBlockResult | undefined): boolean {
	if (!result?.isError) return false;
	const details = asRecord(result.details);
	if (details?.aborted === true || details?.cancelled === true) return true;
	if (details?.exitCode !== undefined) return false;
	const text = extractRawText(result).trim();
	return (
		/(?:^|\n\n)Command aborted$/i.test(text) ||
		/^Operation aborted$/i.test(text) ||
		/^Search curation cancelled/i.test(text)
	);
}

function renderGutteredLines(
	lines: readonly string[],
	startLine: number,
	rawPath?: string,
	lineNumbers?: readonly number[],
	highlighter?: CodeHighlighter,
	activeTheme: Pick<Theme, "fg" | "bold"> = theme,
): Component {
	if (lines.length === 0) return new ToolBlockLines([]);
	const maxLine = lineNumbers?.length
		? lineNumbers.reduce((maximum, line) => Math.max(maximum, line), 0)
		: startLine + lines.length - 1;
	const gutterWidth = Math.max(1, String(maxLine).length);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const normalizedSource = lines.map((line) => replaceTabs(line)).join("\n");
	const highlighted = lang
		? highlighter
			? highlighter.highlight(normalizedSource, lang)
			: highlightCode(normalizedSource, lang)
		: undefined;
	const entries = lines.map((line, index) => ({
		lineNumber: lineNumbers?.[index] ?? startLine + index,
		body: highlighted?.[index] ?? activeTheme.fg("toolOutput", replaceTabs(line)),
	}));
	return new GutteredToolBlockLines(entries, gutterWidth, activeTheme);
}

function formatReadArgs(
	args: Record<string, unknown> | undefined,
	cwd: string,
): { display: string; startLine: number; basePath: string } {
	const rawPath = (asString(args?.path) ?? asString(args?.file_path) ?? "").replace(/^@/, "");
	if (!rawPath) return { display: "", startLine: 1, basePath: "" };
	try {
		const selector = splitReadLineSelector(rawPath);
		const relBase = formatToolBlockPath(selector.path, cwd);
		const rangePart =
			selector.ranges
				?.map((item) => (item.end === undefined ? `${item.start}` : `${item.start}-${item.end}`))
				.join(",") ?? (selector.offset !== undefined ? `${selector.offset}` : "");
		const explicitRange = !rangePart ? formatReadLineRange(args?.offset, args?.limit) : "";
		const suffix = `${rangePart ? `:${rangePart}` : explicitRange}${selector.conflicts ? ":conflicts" : ""}${selector.raw ? ":raw" : ""}`;
		const startLine =
			selector.ranges?.[0]?.start ??
			selector.offset ??
			(typeof args?.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : 1);
		return { display: `${relBase}${suffix}`, startLine, basePath: selector.path };
	} catch {
		const relBase = formatToolBlockPath(rawPath, cwd);
		const explicitRange = formatReadLineRange(args?.offset, args?.limit);
		return { display: `${relBase}${explicitRange}`, startLine: 1, basePath: rawPath };
	}
}

function parseReadLinesAndNumbers(
	rawText: string,
	fallbackStartLine: number,
): { lines: string[]; lineNumbers: number[] } {
	const withoutFooter = rawText.replace(
		/\n\n\[(?:Showing lines \d+-\d+ of \d+(?:[^\]\d][^\]]*)?|\d+ more lines in file\. Continue with path selector :\d+\.)\]\s*$/,
		"",
	);
	const rawLines = splitContentLines(withoutFooter);
	const lines: string[] = [];
	const lineNumbers: number[] = [];
	let currentLine = fallbackStartLine;
	for (const line of rawLines) {
		const marker = /^\[Lines (\d+)-(\d+) of (\d+)\]$/.exec(line);
		if (marker) {
			currentLine = Number.parseInt(marker[1]!, 10);
			continue;
		}
		lines.push(line);
		lineNumbers.push(currentLine);
		currentLine++;
	}
	return { lines, lineNumbers };
}

function shortReadErrorReason(text: string, details: Record<string, unknown> | undefined): string {
	if (details?.oversizedRead) return "too large";
	if (/ENOENT|not found|no such file|does not exist/i.test(text)) return "not found";
	if (/EACCES|EPERM|permission denied/i.test(text)) return "permission denied";
	if (/EISDIR|is a directory/i.test(text)) return "is a directory";
	if (/beyond end of/i.test(text)) return "out of range";
	return "failed";
}

function presentRead(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const activeTheme = input.theme ?? theme;
	const argsRecord = asRecord(input.args);
	const { display, startLine, basePath } = formatReadArgs(argsRecord, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Read", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Read", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Read",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([activeTheme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Read",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const details = asRecord(input.result?.details);
	const rawText = extractRawText(input.result);
	if (input.result?.isError || asRecord(details?.oversizedRead)?.blocked === true) {
		const reason = shortReadErrorReason(rawText, details);
		const errorLines = splitContentLines(rawText).map((line) => activeTheme.fg("error", replaceTabs(line)));
		return {
			title: "Read",
			args: display,
			status: "failure",
			meta: [reason, ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const rawUnsupportedBy = asString(details?.imageUnsupportedByModel);
	const unsupportedBy = rawUnsupportedBy ? singleLineDisplayText(rawUnsupportedBy).trim() : "";
	const warningLine = unsupportedBy
		? activeTheme.fg("warning", `[${unsupportedBy} does not support images; it saw a placeholder instead]`)
		: undefined;
	const imagePart = input.result?.content.find((part) => part.type === "image");
	if (imagePart || /^Read image file \[/i.test(rawText)) {
		// A saved image over the page budget carries only the header, sufficient for common image dimensions.
		const saved = savedReadLines(input.result?.content) === null;
		const data = imagePart?.data ?? (saved ? asString(details?.savedImageHeader) : undefined);
		const mime = imagePart?.mimeType ?? (saved ? asString(details?.savedImageType) : undefined);
		const dimsFromImage = data && mime ? getImageDimensions(data, mime) : null;
		const dimMatch = /(\d+)\s*[x×]\s*(\d+)/.exec(rawText);
		const widthPx =
			asNumber(details?.widthPx) ?? dimsFromImage?.widthPx ?? (dimMatch ? Number(dimMatch[1]) : undefined);
		const heightPx =
			asNumber(details?.heightPx) ?? dimsFromImage?.heightPx ?? (dimMatch ? Number(dimMatch[2]) : undefined);
		const dimsText = widthPx && heightPx ? `${widthPx}×${heightPx}` : undefined;
		const bytes =
			asNumber(details?.bytes) ?? (imagePart?.data ? Buffer.from(imagePart.data, "base64").byteLength : undefined);
		const sizeText = bytes !== undefined ? formatToolBlockByteSize(bytes) : undefined;
		const tail = [dimsText, sizeText].filter((item): item is string => Boolean(item)).join(" · ");
		const line = `${activeTheme.fg("text", "Read image")}${tail ? activeTheme.fg("dim", ` · ${tail}`) : ""}`;
		return {
			title: "Read",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines(warningLine ? [line, warningLine] : [line], Boolean(warningLine)),
		};
	}

	const { lines, lineNumbers } = parseReadLinesAndNumbers(rawText, startLine);
	const archivedLines = savedReadLines(input.result?.content);
	const lineCount = archivedLines ?? lines.length;
	const summary =
		archivedLines === null
			? activeTheme.fg("muted", rawText)
			: activeTheme.fg("text", `Read ${activeTheme.bold(String(lineCount))} ${lineCount === 1 ? "line" : "lines"}`);
	if (!input.expanded || lineCount === 0) {
		return {
			title: "Read",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines(warningLine ? [summary, warningLine] : [summary], Boolean(warningLine)),
		};
	}

	const guttered = renderGutteredLines(lines, startLine, basePath, lineNumbers, input.highlighter, activeTheme);
	return {
		title: "Read",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: warningLine ? new ToolBlockRecords([guttered, new ToolBlockLines([warningLine], true)]) : guttered,
	};
}

function formatSearchArgs(args: Record<string, unknown> | undefined, cwd: string): string {
	const pattern = singleLineDisplayText(asString(args?.pattern) ?? "");
	const rawPaths = args?.paths;
	const pathList = Array.isArray(rawPaths)
		? rawPaths.map((entry) => asString(entry) ?? "").filter(Boolean)
		: typeof rawPaths === "string" && rawPaths.trim() !== ""
			? [rawPaths.trim()]
			: typeof args?.path === "string" && args.path.trim() !== ""
				? [args.path.trim()]
				: [];
	const glob = asString(args?.glob)?.trim();
	let scope = pathList
		.map((entry) => formatToolBlockPath(entry, cwd))
		.filter(Boolean)
		.join(", ");
	if (glob) {
		scope = !scope || scope === "." ? glob : `${scope.replace(/\/+$/, "")}/${glob}`;
	}
	return scope ? `/${pattern}/ in ${scope}` : `/${pattern}/`;
}

function parseSearchRows(rawText: string): { rows: string[]; matchCount: number; fileCount: number } {
	const withoutNotices = rawText
		.replace(
			/\n\n\[(?:\d+ matching files shown[^\]]*|Search collected the first [^\]]*|Skipped missing paths:[^\]]*|[^\]]*limit reached[^\]]*|skip is ignored[^\]]*)\]/g,
			"",
		)
		.trimEnd();
	if (!withoutNotices || withoutNotices === "No matches found" || withoutNotices === "0") {
		return { rows: [], matchCount: 0, fileCount: 0 };
	}
	const files = new Set<string>();
	const rows: string[] = [];
	let matchCount = 0;
	for (const line of withoutNotices.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "No matches found" || trimmed.startsWith("# ")) continue;
		rows.push(line);
		const fileMatch = /^(.+?)(?::(\d+): |-(\d+)- )/.exec(line);
		if (fileMatch?.[1]) {
			files.add(fileMatch[1]);
			if (fileMatch[2] !== undefined) matchCount++;
		} else {
			matchCount++;
		}
	}
	return { rows, matchCount, fileCount: files.size };
}

function presentSearch(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const display = formatSearchArgs(argsRecord, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Search", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Search", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Search",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Search",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	if (input.result?.isError) {
		const errorLines = splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "Search",
			args: display,
			status: "failure",
			meta: ["failed", ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const details = asRecord(input.result?.details);
	const parsed = parseSearchRows(rawText);
	const matchCount = asNumber(details?.matchCount) ?? parsed.matchCount;
	const fileCount =
		asNumber(details?.fileCount) ??
		(Array.isArray(details?.files) ? details.files.length : undefined) ??
		parsed.fileCount;

	if (matchCount === 0 && parsed.rows.length === 0) {
		return {
			title: "Search",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([theme.fg("muted", "No matches")]),
		};
	}

	const effectiveMatches = matchCount > 0 ? matchCount : parsed.rows.length;
	const effectiveFiles = fileCount > 0 ? fileCount : 1;
	const summary = theme.fg(
		"text",
		`${theme.bold(String(effectiveMatches))} ${effectiveMatches === 1 ? "match" : "matches"} in ${theme.bold(String(effectiveFiles))} ${effectiveFiles === 1 ? "file" : "files"}`,
	);
	const styledRows = parsed.rows.map((line) => theme.fg("toolOutput", replaceTabs(line)));
	const collapsedRows = collapseToolBlockLines(styledRows, TOOL_BLOCK_LIMITS.search, input.expanded);

	return {
		title: "Search",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines([summary, ...collapsedRows], input.expanded),
	};
}

function formatFindArgs(args: Record<string, unknown> | undefined, cwd: string): string {
	const rawPaths = args?.paths;
	if (Array.isArray(rawPaths) && rawPaths.length > 0) {
		return rawPaths
			.map((entry) => formatToolBlockPath(String(entry ?? ""), cwd))
			.filter(Boolean)
			.join(", ");
	}
	const single = asString(args?.pattern) ?? asString(args?.path) ?? asString(rawPaths);
	return single ? formatToolBlockPath(single, cwd) : "";
}

function presentFind(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const display = formatFindArgs(argsRecord, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Find", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Find", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Find",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Find",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	if (input.result?.isError) {
		const errorLines = splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "Find",
			args: display,
			status: "failure",
			meta: [/ENOENT|not found/i.test(rawText) ? "not found" : "failed", ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const details = asRecord(input.result?.details);
	const detailFiles = Array.isArray(details?.files)
		? details.files.map((item) => terminalDisplayText(String(item ?? ""))).filter(Boolean)
		: undefined;
	const withoutNotices = rawText.replace(/\n\n\[[^\]]+\]\s*$/, "").trimEnd();
	const textRows =
		!withoutNotices || withoutNotices === "No files found matching pattern" || withoutNotices === "No matches"
			? []
			: withoutNotices.split("\n").filter((line) => line.trim() !== "");
	const fileRows = detailFiles ?? textRows;
	const fileCount = asNumber(details?.fileCount) ?? fileRows.length;

	if (fileCount === 0 && fileRows.length === 0) {
		return {
			title: "Find",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([theme.fg("muted", "No matches")]),
		};
	}

	const summary = theme.fg("text", `${theme.bold(String(fileCount))} ${fileCount === 1 ? "file" : "files"}`);
	const styledRows = fileRows.map((line) => theme.fg("toolOutput", replaceTabs(line)));
	const collapsedRows = collapseToolBlockLines(styledRows, TOOL_BLOCK_LIMITS.paths, input.expanded);

	return {
		title: "Find",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines([summary, ...collapsedRows], input.expanded),
	};
}

function presentList(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const rawPath = asString(argsRecord?.path) ?? ".";
	const display = formatToolBlockPath(rawPath, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "List", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "List", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "List",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "List",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	if (input.result?.isError) {
		const errorLines = splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "List",
			args: display,
			status: "failure",
			meta: [/ENOENT|not found/i.test(rawText) ? "not found" : "failed", ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const withoutNotices = rawText.replace(/\n\n\[[^\]]+\]\s*$/, "").trimEnd();
	const entryRows =
		!withoutNotices || withoutNotices === "(empty directory)" || withoutNotices === "No matches"
			? []
			: withoutNotices.split("\n").filter((line) => line.trim() !== "");

	if (entryRows.length === 0) {
		return {
			title: "List",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([theme.fg("muted", "No matches")]),
		};
	}

	const count = entryRows.length;
	const summary = theme.fg("text", `${theme.bold(String(count))} ${count === 1 ? "entry" : "entries"}`);
	const styledRows = entryRows.map((line) => theme.fg("toolOutput", replaceTabs(line)));
	const collapsedRows = collapseToolBlockLines(styledRows, TOOL_BLOCK_LIMITS.paths, input.expanded);

	return {
		title: "List",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines([summary, ...collapsedRows], input.expanded),
	};
}

function formatWaitTaskStatusLine(observation: WaitOutcome, hasOutput: boolean): string {
	if (observation.kind === "settled" && observation.result.kind === "cancelled") {
		const status = waitStatus(observation, hasOutput);
		const head = `◼ ${status.label}`;
		return theme.fg("muted", head) + (status.detail ? theme.fg("dim", ` · ${status.detail}`) : "");
	}
	const status = waitStatus(observation, hasOutput);
	const head = `${status.glyph} ${status.label}`;
	return (
		theme.fg(status.tone, head) + (status.detail ? theme.fg("dim", " · ") + theme.fg("muted", status.detail) : "")
	);
}

function presentWait(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const taskId = singleLineDisplayText(asString(argsRecord?.id) ?? "");
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: true });

	if (isWaitingForApproval(input)) {
		return { title: "Wait", args: taskId, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Wait", args: taskId, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Wait",
			args: taskId,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Wait",
			args: taskId,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	const details = asRecord(input.result?.details);
	const observation = details?.observation as WaitOutcome | undefined;

	if (input.result?.isError) {
		const taskErr = presentTaskError(rawText, taskId || undefined);
		const errorLines = taskErr
			? [theme.fg("error", taskErr.headline), ...(taskErr.hint ? [theme.fg("dim", taskErr.hint)] : [])]
			: splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "Wait",
			args: taskId,
			status: "failure",
			meta: ["failed", ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	if (observation) {
		const truncation = details?.truncation as TruncationResult | undefined;
		const fullOutputPath = asString(details?.fullOutputPath);
		const tail = waitResultTail({
			observation,
			truncated: truncation?.truncated === true,
			fullOutputPath,
		});
		const untailed = rawText.endsWith(tail) ? rawText.slice(0, -tail.length) : rawText;
		const trimmed = untailed.trimEnd();
		const statusFooter =
			/\n\nTask \S+ (?:completed with exit code \d+|is still running[^\n]*|exited with code \d+|ended without an exit code|failed[^\n]*|was cancelled[^\n]*)\.?$/.exec(
				trimmed,
			);
		const stripped = (statusFooter === null ? untailed : trimmed.slice(0, statusFooter.index)).replace(/\n+$/, "");
		const hasOutput = stripped.trim() !== "" && stripped.trim() !== EMPTY_OUTPUT_TEXT;
		const statusLine = formatWaitTaskStatusLine(observation, hasOutput);
		const outputLines = hasOutput
			? collapseToolBlockLines(
					stripped.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line))),
					TOOL_BLOCK_LIMITS.bash,
					input.expanded,
					true,
				)
			: [theme.fg("muted", EMPTY_OUTPUT_TEXT)];
		const blockStatus: ToolBlockStatus =
			observation.kind === "settled"
				? observation.result.kind === "completed"
					? observation.result.exitCode === 0
						? "success"
						: "failure"
					: observation.result.kind === "cancelled"
						? "stopped"
						: "failure"
				: "success";
		return {
			title: "Wait",
			args: taskId,
			status: blockStatus,
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([statusLine, ...outputLines], input.expanded),
		};
	}

	const fallbackLines = splitContentLines(rawText).map((line) => theme.fg("toolOutput", replaceTabs(line)));
	return {
		title: "Wait",
		args: taskId,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details:
			fallbackLines.length > 0
				? new ToolBlockLines(
						collapseToolBlockLines(fallbackLines, TOOL_BLOCK_LIMITS.bash, input.expanded, true),
						input.expanded,
					)
				: undefined,
	};
}

function formatBashCommandArg(rawCommand: string | undefined): string {
	if (!rawCommand) return "";
	const normalized = terminalDisplayText(rawCommand).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const first = (lines[0] ?? "").replace(/\t/g, " ");
	return lines.length > 1 ? `${first}…` : first;
}

type SettledBashState =
	| { readonly kind: "background"; readonly output: string }
	| { readonly kind: "interrupted"; readonly output: string }
	| { readonly kind: "timeout"; readonly output: string; readonly seconds: string }
	| { readonly kind: "failure"; readonly output: string; readonly exitCode?: number }
	| { readonly kind: "success"; readonly output: string };

function stripBashTruncationFooter(rawText: string): string {
	return rawText
		.replace(/\n\n\[Showing (?:last [^\]]+|lines \d+-\d+ of \d+(?:[^\]\d][^\]]*)?)\]\s*$/, "")
		.replace(/\n+$/, "");
}

function stripOwnedFooter(rawText: string, pattern: RegExp): { text: string; match: RegExpExecArray | null } {
	const match = pattern.exec(rawText);
	if (!match) return { text: stripBashTruncationFooter(rawText), match: null };
	return { text: stripBashTruncationFooter(rawText.slice(0, match.index)), match };
}

function classifySettledBashResult(input: BuiltinToolBlockInput, rawText: string): SettledBashState {
	const isError = input.result?.isError === true;
	const details = asRecord(input.result?.details);
	const argsRecord = asRecord(input.args);
	const waitPolicy = asRecord(argsRecord?.wait);
	const observation = details?.observation as WaitOutcome | undefined;
	const settled = observation?.kind === "settled" ? observation.result : undefined;
	const detailExitCode =
		asNumber(details?.exitCode) ?? (settled && "exitCode" in settled ? asNumber(settled.exitCode) : undefined);

	if (observation?.kind === "yielded") {
		const { text } = stripOwnedFooter(rawText, /(?:\n\n|^)Command is still running \(task [^)]+\)\.[\s\S]*$/);
		return { kind: "background", output: text };
	}

	if (settled) {
		const truncation = details?.truncation as TruncationResult | undefined;
		const fullOutputPath = asString(details?.fullOutputPath);
		const tail = waitResultTail({
			observation: observation!,
			truncated: truncation?.truncated === true,
			fullOutputPath,
		});
		const withoutWaitTail = rawText.endsWith(tail) ? rawText.slice(0, -tail.length) : rawText;

		if (settled.kind === "cancelled") {
			if (settled.cause === "execution-timeout") {
				const { text, match } = stripOwnedFooter(
					withoutWaitTail,
					/(?:\n\n|^)Command timed out after ([\d.]+) seconds[\s\S]*$/,
				);
				const timeoutFromSettled =
					asNumber(settled.executionTimeoutMs) !== undefined
						? String(Math.round((asNumber(settled.executionTimeoutMs)! / 1000) * 10) / 10)
						: undefined;
				const seconds =
					timeoutFromSettled ??
					match?.[1] ??
					(asNumber(details?.timeoutSeconds) !== undefined
						? String(asNumber(details?.timeoutSeconds))
						: undefined) ??
					(asNumber(argsRecord?.timeout) !== undefined ? String(asNumber(argsRecord?.timeout)) : "0");
				return { kind: "timeout", output: text, seconds };
			}
			const { text } = stripOwnedFooter(withoutWaitTail, /(?:\n\n|^)Command aborted\s*$/);
			return { kind: "interrupted", output: text };
		}

		if (settled.kind === "failed") {
			const { text } =
				detailExitCode !== undefined
					? stripOwnedFooter(
							withoutWaitTail,
							new RegExp(`(?:\\n\\n|^)Command exited with code ${detailExitCode}\\s*$`),
						)
					: stripOwnedFooter(withoutWaitTail, /(?:\n\n|^)Command terminated without an exit code\s*$/);
			return {
				kind: "failure",
				output: text,
				exitCode: detailExitCode !== undefined && detailExitCode !== 0 ? detailExitCode : undefined,
			};
		}

		const exitCode = detailExitCode ?? 0;
		if (exitCode === 0 && !isError) {
			return { kind: "success", output: stripBashTruncationFooter(withoutWaitTail) };
		}
		const { text } =
			exitCode !== 0
				? stripOwnedFooter(withoutWaitTail, new RegExp(`(?:\\n\\n|^)Command exited with code ${exitCode}\\s*$`))
				: { text: stripBashTruncationFooter(withoutWaitTail) };
		return {
			kind: "failure",
			output: text,
			exitCode: exitCode !== 0 ? exitCode : undefined,
		};
	}

	if (details?.aborted === true || details?.cancelled === true) {
		const { text } = stripOwnedFooter(rawText, /(?:\n\n|^)Command aborted\s*$/);
		return { kind: "interrupted", output: text };
	}

	if (details?.timedOut === true || asNumber(details?.timedOutSeconds) !== undefined) {
		const { text, match } = stripOwnedFooter(rawText, /(?:\n\n|^)Command timed out after ([\d.]+) seconds[\s\S]*$/);
		const seconds =
			(asNumber(details?.timedOutSeconds) !== undefined ? String(asNumber(details?.timedOutSeconds)) : undefined) ??
			match?.[1] ??
			(asNumber(details?.timeoutSeconds) !== undefined ? String(asNumber(details?.timeoutSeconds)) : undefined) ??
			(asNumber(argsRecord?.timeout) !== undefined ? String(asNumber(argsRecord?.timeout)) : "0");
		return { kind: "timeout", output: text, seconds };
	}

	if (detailExitCode !== undefined) {
		if (detailExitCode === 0 && !isError) {
			return { kind: "success", output: stripBashTruncationFooter(rawText) };
		}
		const { text } = stripOwnedFooter(
			rawText,
			new RegExp(`(?:\\n\\n|^)Command exited with code ${detailExitCode}\\s*$`),
		);
		return {
			kind: "failure",
			output: text,
			exitCode: detailExitCode !== 0 ? detailExitCode : undefined,
		};
	}

	if (!isError) {
		if (waitPolicy?.kind === "background") {
			const { text } = stripOwnedFooter(rawText, /(?:\n\n|^)Command is still running \(task [^)]+\)\.[\s\S]*$/);
			return { kind: "background", output: text };
		}
		return { kind: "success", output: stripBashTruncationFooter(rawText) };
	}

	const exitFooter = stripOwnedFooter(rawText, /(?:\n\n|^)Command exited with code (\d+)\s*$/);
	if (exitFooter.match) {
		const parsedCode = Number.parseInt(exitFooter.match[1]!, 10);
		return {
			kind: "failure",
			output: exitFooter.text,
			exitCode: parsedCode !== 0 ? parsedCode : undefined,
		};
	}

	const timeoutFooter = stripOwnedFooter(rawText, /(?:\n\n|^)Command timed out after ([\d.]+) seconds[\s\S]*$/);
	if (timeoutFooter.match) {
		return { kind: "timeout", output: timeoutFooter.text, seconds: timeoutFooter.match[1]! };
	}

	const abortFooter = stripOwnedFooter(rawText, /(?:\n\n|^)Command aborted\s*$/);
	if (abortFooter.match || isInterruptedResult(input.result)) {
		return { kind: "interrupted", output: abortFooter.text };
	}

	const noExitFooter = stripOwnedFooter(rawText, /(?:\n\n|^)Command terminated without an exit code\s*$/);
	return { kind: "failure", output: noExitFooter.text };
}

function presentBash(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	if (argsRecord?.action === "wait") {
		return presentWait(input);
	}

	const commandArg = formatBashCommandArg(asString(argsRecord?.command));
	const explicitTimeout = asNumber(argsRecord?.timeout);
	const timeoutMeta = explicitTimeout !== undefined && explicitTimeout > 0 ? `timeout ${explicitTimeout}s` : undefined;
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: true });

	if (isWaitingForApproval(input)) {
		return { title: "Bash", args: commandArg, status: "warning", meta: ["waiting for approval"] };
	}

	const rawText = extractRawText(input.result);

	if (isRunning) {
		const runningOutput = stripBashTruncationFooter(rawText);
		const meta = [...(elapsed ? [elapsed] : []), ...(timeoutMeta ? [timeoutMeta] : [])];
		if (!input.argsComplete || runningOutput === "" || runningOutput === EMPTY_OUTPUT_TEXT) {
			return {
				title: "Bash",
				args: commandArg,
				status: "running",
				meta: meta.length > 0 ? meta : undefined,
			};
		}
		const liveLines = runningOutput.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line)));
		return {
			title: "Bash",
			args: commandArg,
			status: "running",
			meta: meta.length > 0 ? meta : undefined,
			details: new ToolBlockLines(
				collapseToolBlockLines(liveLines, TOOL_BLOCK_LIMITS.bash, input.expanded, true),
				input.expanded,
			),
		};
	}

	if (isRejectedResult(input)) {
		return {
			title: "Bash",
			args: commandArg,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}

	const classified = classifySettledBashResult(input, rawText);

	if (classified.kind === "background") {
		const taskId = asString(asRecord(asRecord(input.result?.details)?.observation)?.taskId);
		// Shells are managed in /tasks; the agent panel lists subagents only.
		const manage = taskId !== undefined && taskId !== "" && input.canManageTask?.(taskId) === true;
		const bgLine = `${theme.fg("text", "Running in background")}${manage ? theme.fg("dim", ` · ${slashCommandHint("/tasks to manage")}`) : ""}`;
		const hasOutput = classified.output !== "" && classified.output !== EMPTY_OUTPUT_TEXT;
		const outputLines = hasOutput
			? collapseToolBlockLines(
					classified.output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line))),
					TOOL_BLOCK_LIMITS.bash,
					input.expanded,
					true,
				)
			: [];
		return {
			title: "Bash",
			args: commandArg,
			status: "success",
			meta: ["background"],
			details: new ToolBlockLines([bgLine, ...outputLines], input.expanded),
		};
	}

	if (classified.kind === "interrupted") {
		const hasOutput = classified.output !== "" && classified.output !== EMPTY_OUTPUT_TEXT;
		const outputLines = hasOutput
			? collapseToolBlockLines(
					classified.output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line))),
					TOOL_BLOCK_LIMITS.bash,
					input.expanded,
					true,
				)
			: [];
		return {
			title: "Bash",
			args: commandArg,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
			details: outputLines.length > 0 ? new ToolBlockLines(outputLines, input.expanded) : undefined,
		};
	}

	if (classified.kind === "timeout") {
		const hasOutput = classified.output !== "" && classified.output !== EMPTY_OUTPUT_TEXT;
		const outputLines = hasOutput
			? collapseToolBlockLines(
					classified.output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line))),
					TOOL_BLOCK_LIMITS.bash,
					input.expanded,
					true,
				)
			: [];
		return {
			title: "Bash",
			args: commandArg,
			status: "failure",
			meta: [`timed out after ${classified.seconds}s`],
			details: outputLines.length > 0 ? new ToolBlockLines(outputLines, input.expanded) : undefined,
		};
	}

	if (classified.kind === "failure") {
		const stateWord =
			classified.exitCode !== undefined && classified.exitCode !== 0 ? `exit ${classified.exitCode}` : "failed";
		const meta = [stateWord, ...(elapsed ? [elapsed] : [])];
		if (classified.output === "" || classified.output === EMPTY_OUTPUT_TEXT) {
			return {
				title: "Bash",
				args: commandArg,
				status: "failure",
				meta,
				details: new ToolBlockLines([theme.fg("muted", EMPTY_OUTPUT_TEXT)]),
			};
		}
		const rawLines = classified.output.split("\n");
		const styledLines = rawLines.map((line, index) =>
			theme.fg(index === rawLines.length - 1 ? "error" : "toolOutput", replaceTabs(line)),
		);
		return {
			title: "Bash",
			args: commandArg,
			status: "failure",
			meta,
			details: new ToolBlockLines(
				collapseToolBlockLines(styledLines, TOOL_BLOCK_LIMITS.bash, input.expanded, true),
				input.expanded,
			),
		};
	}

	const meta = [...(elapsed ? [elapsed] : []), ...(timeoutMeta ? [timeoutMeta] : [])];
	if (classified.output === "" || classified.output === EMPTY_OUTPUT_TEXT) {
		return {
			title: "Bash",
			args: commandArg,
			status: "success",
			meta: meta.length > 0 ? meta : undefined,
			details: new ToolBlockLines([theme.fg("muted", EMPTY_OUTPUT_TEXT)]),
		};
	}

	const styledLines = classified.output.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line)));
	return {
		title: "Bash",
		args: commandArg,
		status: "success",
		meta: meta.length > 0 ? meta : undefined,
		details: new ToolBlockLines(
			collapseToolBlockLines(styledLines, TOOL_BLOCK_LIMITS.bash, input.expanded, true),
			input.expanded,
		),
	};
}

interface ParsedDiffEntry {
	readonly kind: "line";
	readonly prefix: "+" | "-" | " ";
	readonly lineNum: string;
	readonly content: string;
}

interface ParsedDiffSeparator {
	readonly kind: "sep";
}

type ParsedDiffToken = ParsedDiffEntry | ParsedDiffSeparator;

function parseDisplayDiffLine(line: string): ParsedDiffToken | undefined {
	if (/^\s*(?:\.\.\.|⋮)\s*$/.test(line)) {
		return { kind: "sep" };
	}
	if (line.length < 2) return undefined;
	const prefix = line[0];
	if (prefix !== "+" && prefix !== "-" && prefix !== " ") return undefined;
	let cursor = 1;
	while (cursor < line.length && line[cursor] === " ") cursor++;
	const numStart = cursor;
	while (cursor < line.length) {
		const code = line.charCodeAt(cursor);
		if (code < 48 || code > 57) break;
		cursor++;
	}
	if (cursor === numStart || cursor >= line.length || line[cursor] !== " ") return undefined;
	return {
		kind: "line",
		prefix,
		lineNum: line.slice(numStart, cursor),
		content: line.slice(cursor + 1),
	};
}

function buildEditHunks(diffText: string): {
	hunks: ParsedDiffEntry[][];
	added: number;
	removed: number;
	lineNumWidth: number;
} {
	const rawSegments: ParsedDiffEntry[][] = [];
	let currentSegment: ParsedDiffEntry[] = [];
	let added = 0;
	let removed = 0;

	for (const rawLine of diffText.split("\n")) {
		const token = parseDisplayDiffLine(rawLine);
		if (!token) continue;
		if (token.kind === "sep") {
			if (currentSegment.length > 0) {
				rawSegments.push(currentSegment);
				currentSegment = [];
			}
			continue;
		}
		if (token.prefix === "+") added++;
		else if (token.prefix === "-") removed++;
		currentSegment.push(token);
	}
	if (currentSegment.length > 0) {
		rawSegments.push(currentSegment);
	}

	const hunks: ParsedDiffEntry[][] = [];
	const maxContext = 2;

	for (const segment of rawSegments) {
		const changeIndices: number[] = [];
		for (let i = 0; i < segment.length; i++) {
			if (segment[i]!.prefix !== " ") changeIndices.push(i);
		}
		if (changeIndices.length === 0) continue;

		let hunkStart = Math.max(0, changeIndices[0]! - maxContext);
		let prevChange = changeIndices[0]!;

		for (let idx = 1; idx < changeIndices.length; idx++) {
			const nextChange = changeIndices[idx]!;
			const contextBetween = nextChange - prevChange - 1;
			if (contextBetween > maxContext * 2) {
				const hunkEnd = Math.min(segment.length - 1, prevChange + maxContext);
				hunks.push(segment.slice(hunkStart, hunkEnd + 1));
				hunkStart = Math.max(0, nextChange - maxContext);
			}
			prevChange = nextChange;
		}

		const finalEnd = Math.min(segment.length - 1, prevChange + maxContext);
		hunks.push(segment.slice(hunkStart, finalEnd + 1));
	}

	let lineNumWidth = 1;
	for (const hunk of hunks) {
		for (const entry of hunk) {
			lineNumWidth = Math.max(lineNumWidth, entry.lineNum.length);
		}
	}

	return { hunks, added, removed, lineNumWidth };
}

function shortEditErrorReason(text: string): string {
	if (/Could not find|text-not-found|no match/i.test(text)) return "no match";
	if (/occurrences|text-not-unique|must be unique/i.test(text)) return "not unique";
	if (/overlap|edits-overlap/i.test(text)) return "overlapping edits";
	if (/No changes made|no-change/i.test(text)) return "no change";
	if (/ENOENT|not found|Could not edit file/i.test(text)) return "not found";
	return "failed";
}

function fallbackEditDiffFromArgs(argsRecord: Record<string, unknown> | undefined): string | undefined {
	if (!argsRecord) return undefined;
	if (Array.isArray(argsRecord.edits) && argsRecord.edits.length > 0) {
		const parts: string[] = [];
		for (const rawEdit of argsRecord.edits) {
			const edit = asRecord(rawEdit);
			const oldText = asString(edit?.oldText);
			const newText = asString(edit?.newText);
			if (oldText !== undefined && newText !== undefined) {
				parts.push(generateDiffString(oldText, newText, 2).diff);
			}
		}
		return parts.length > 0 ? parts.join("\n ...\n") : undefined;
	}
	const oldText = asString(argsRecord.oldText);
	const newText = asString(argsRecord.newText);
	if (oldText !== undefined && newText !== undefined) {
		return generateDiffString(oldText, newText, 2).diff;
	}
	return undefined;
}

function presentEdit(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const rawPath = asString(argsRecord?.path) ?? asString(argsRecord?.file_path) ?? "";
	const display = formatToolBlockPath(rawPath, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Edit", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Edit", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Edit",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Edit",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	if (input.result?.isError) {
		const reason = shortEditErrorReason(rawText);
		const errorLines = splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "Edit",
			args: display,
			status: "failure",
			meta: [reason, ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const details = asRecord(input.result?.details);
	const diffText = asString(details?.diff) ?? fallbackEditDiffFromArgs(argsRecord) ?? "";
	const { hunks, added, removed, lineNumWidth } = buildEditHunks(diffText);
	const hunkCount = hunks.length;
	const meta = [...(hunkCount > 1 ? [`${hunkCount} hunks`] : []), ...(elapsed ? [elapsed] : [])];

	const summaryRow = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`;
	const diffRows: string[] = [];

	for (let h = 0; h < hunks.length; h++) {
		if (h > 0) {
			diffRows.push(theme.fg("dim", "⋮"));
		}
		for (const entry of hunks[h]!) {
			const num = entry.lineNum.padStart(lineNumWidth, " ");
			const body = replaceTabs(terminalDisplayText(entry.content));
			if (entry.prefix === "+") {
				diffRows.push(theme.fg("toolDiffAdded", `+${num}  ${body}`));
			} else if (entry.prefix === "-") {
				diffRows.push(theme.fg("toolDiffRemoved", `-${num}  ${body}`));
			} else {
				diffRows.push(theme.fg("toolDiffContext", ` ${num}  ${body}`));
			}
		}
	}

	const collapsedDiffRows = collapseToolBlockLines(diffRows, TOOL_BLOCK_LIMITS.diff, input.expanded);
	return {
		title: "Edit",
		args: display,
		status: "success",
		meta: meta.length > 0 ? meta : undefined,
		details: new ToolBlockLines([summaryRow, ...collapsedDiffRows], input.expanded),
	};
}

function presentWrite(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const rawPath = asString(argsRecord?.path) ?? asString(argsRecord?.file_path) ?? "";
	const display = formatToolBlockPath(rawPath, input.cwd);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Write", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Write", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Write",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Write",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	if (input.result?.isError) {
		const reason = /EACCES|EPERM|permission denied/i.test(rawText)
			? "permission denied"
			: /EISDIR|is a directory/i.test(rawText)
				? "is a directory"
				: /ENOENT|not found/i.test(rawText)
					? "not found"
					: "failed";
		const errorLines = splitContentLines(rawText).map((line) => theme.fg("error", replaceTabs(line)));
		return {
			title: "Write",
			args: display,
			status: "failure",
			meta: [reason, ...(elapsed ? [elapsed] : [])],
			details: errorLines.length > 0 ? new ToolBlockLines(errorLines, true) : undefined,
		};
	}

	const rawContent = asString(argsRecord?.content) ?? "";
	const normalizedContent = terminalDisplayText(rawContent).replace(/\r\n/g, "\n").replace(/\r/g, "");
	const contentLines =
		normalizedContent === ""
			? []
			: normalizedContent.endsWith("\n")
				? normalizedContent.slice(0, -1).split("\n")
				: normalizedContent.split("\n");
	const details = asRecord(input.result?.details);
	const lineCount = asNumber(details?.lineCount) ?? contentLines.length;
	const isNewFile =
		details?.isNewFile === true ||
		details?.newFile === true ||
		details?.created === true ||
		/\bnew file\b/i.test(rawText);

	const summary =
		theme.fg("text", `Wrote ${theme.bold(String(lineCount))} ${lineCount === 1 ? "line" : "lines"}`) +
		(isNewFile ? theme.fg("dim", " · new file") : "");

	if (!input.expanded || contentLines.length === 0) {
		return {
			title: "Write",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([summary]),
		};
	}

	return {
		title: "Write",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: renderGutteredLines(contentLines, 1, rawPath, undefined, input.highlighter),
	};
}

function formatTodoArgs(argsRecord: Record<string, unknown> | undefined): string {
	const action = singleLineDisplayText(asString(argsRecord?.action) ?? "").trim();
	const rawId = asString(argsRecord?.id)?.trim();
	const rawTitle = asString(argsRecord?.title)?.trim();
	if (action === "create" && rawTitle) {
		return `${action} · ${singleLineDisplayText(rawTitle)}`;
	}
	if (rawId) {
		return `${action} · ${displayTodoId(rawId)}`;
	}
	if (rawTitle) {
		return `${action} · ${singleLineDisplayText(rawTitle)}`;
	}
	return action;
}

function renderExpandedTodoGroupedList(todos: TodoFrontMatter[], currentSessionId?: string): string[] {
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const sections: Array<{ label: string; items: TodoFrontMatter[] }> = [
		{ label: "Assigned todos", items: assignedTodos },
		{ label: "Open todos", items: openTodos },
		{ label: "Closed todos", items: closedTodos },
	];
	sections.forEach((section, index) => {
		if (index > 0) lines.push("");
		lines.push(theme.fg("muted", `${section.label} (${section.items.length})`));
		if (section.items.length === 0) {
			lines.push(theme.fg("dim", "  none"));
			return;
		}
		for (const todo of section.items) {
			const closed = isTodoClosed(getTodoStatus(todo));
			const idText = theme.fg("accent", formatTodoId(normalizeTodoId(todo.id)));
			const titleText = theme.fg(closed ? "dim" : "text", singleLineDisplayText(getTodoTitle(todo)));
			const tags = todo.tags?.length ? theme.fg("dim", ` [${todo.tags.join(", ")}]`) : "";
			const assigned =
				todo.assigned_to_session !== undefined
					? theme.fg(
							todo.assigned_to_session === currentSessionId ? "success" : "dim",
							` (assigned: ${todo.assigned_to_session}${todo.assigned_to_session === currentSessionId ? ", current" : ""})`,
						)
					: "";
			lines.push(`  ${idText}  ${titleText}${tags}${assigned}`);
		}
	});
	return lines;
}

function presentTodo(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const display = formatTodoArgs(argsRecord);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: false });

	if (isWaitingForApproval(input)) {
		return { title: "Todo", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Todo", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Todo",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Todo",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const details = input.result?.details as TodoToolDetails | undefined;
	const rawText = extractRawText(input.result);

	if (input.result?.isError || details?.error) {
		const errorMessage = terminalDisplayText(details?.error ?? rawText).replace(/^Error:\s*/i, "");
		return {
			title: "Todo",
			args: display,
			status: "failure",
			meta: [/not found/i.test(errorMessage) ? "not found" : "failed", ...(elapsed ? [elapsed] : [])],
			details: errorMessage ? new ToolBlockLines([theme.fg("error", errorMessage)]) : undefined,
		};
	}

	const action = details?.action ?? (asString(argsRecord?.action) as TodoToolDetails["action"] | undefined);
	if (action === "list" || action === "list-all") {
		const todos: TodoFrontMatter[] =
			details && "todos" in details && Array.isArray(details.todos) ? details.todos : [];
		const currentSessionId = details && "currentSessionId" in details ? details.currentSessionId : undefined;
		const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
		const summary = theme.fg(
			"text",
			`${theme.bold(String(openTodos.length))} open · ${theme.bold(String(assignedTodos.length))} assigned · ${theme.bold(String(closedTodos.length))} closed`,
		);
		if (input.expanded) {
			const grouped = renderExpandedTodoGroupedList(todos, currentSessionId);
			return {
				title: "Todo",
				args: display,
				status: "success",
				meta: elapsed ? [elapsed] : undefined,
				details: new ToolBlockLines([summary, ...grouped], true),
			};
		}
		const ordered = [...openTodos, ...assignedTodos, ...closedTodos];
		const itemRows = ordered.map((todo) => {
			const closed = isTodoClosed(getTodoStatus(todo));
			return `${theme.fg("accent", formatTodoId(normalizeTodoId(todo.id)))}  ${theme.fg(closed ? "dim" : "text", singleLineDisplayText(getTodoTitle(todo)))}`;
		});
		const collapsedItems = collapseToolBlockLines(itemRows, TOOL_BLOCK_LIMITS.todo, false);
		return {
			title: "Todo",
			args: display,
			status: "success",
			meta: elapsed ? [elapsed] : undefined,
			details: new ToolBlockLines([summary, ...collapsedItems]),
		};
	}

	const todo = (details && "todo" in details ? details.todo : undefined) as TodoRecord | undefined;
	const todoId = todo?.id
		? formatTodoId(normalizeTodoId(todo.id))
		: asString(argsRecord?.id)
			? displayTodoId(asString(argsRecord?.id)!)
			: "";
	const statusValue = todo ? getTodoStatus(todo) : (asString(argsRecord?.status) ?? "");
	const verb =
		action === "create"
			? "Created"
			: action === "update"
				? isTodoClosed(statusValue)
					? "Closed"
					: "Updated"
				: action === "claim"
					? "Claimed"
					: action === "release"
						? "Released"
						: action === "delete"
							? "Deleted"
							: action === "append"
								? "Updated"
								: "Read";
	const headline = todoId ? `${verb} ${todoId}` : verb;
	const lines = [theme.fg("text", headline)];
	if (input.expanded && todo) {
		lines.push(
			theme.fg(
				"toolOutput",
				`${formatTodoId(normalizeTodoId(todo.id))}  ${singleLineDisplayText(getTodoTitle(todo))}`,
			),
		);
		if (todo.body?.trim()) {
			for (const bodyLine of terminalDisplayText(todo.body.trim()).split("\n")) {
				lines.push(theme.fg("muted", bodyLine));
			}
		}
	}
	return {
		title: "Todo",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines(lines, input.expanded),
	};
}

export interface WebSearchSourceEntry {
	readonly title: string;
	readonly host: string;
}

export function extractHostFromUrl(rawUrl: string): string {
	const cleaned = singleLineDisplayText(rawUrl).trim();
	if (!cleaned) return "";
	try {
		return new URL(cleaned).hostname.replace(/^www\./i, "");
	} catch {
		return stripUrlScheme(cleaned)
			.replace(/\/.*$/, "")
			.replace(/^www\./i, "");
	}
}

export function parseWebSearchSources(
	rawText: string,
	details: Record<string, unknown> | undefined,
): WebSearchSourceEntry[] {
	const sources: WebSearchSourceEntry[] = [];
	const seen = new Set<string>();
	const addSource = (title: string, urlOrHost: string) => {
		const cleanTitle = singleLineDisplayText(title).trim();
		const host = extractHostFromUrl(urlOrHost);
		if (!cleanTitle) return;
		const key = `${cleanTitle}::${host}`;
		if (seen.has(key)) return;
		seen.add(key);
		sources.push({ title: cleanTitle, host });
	};

	const directSources = Array.isArray(details?.sources)
		? details.sources
		: Array.isArray(details?.results)
			? details.results
			: undefined;
	if (directSources) {
		for (const item of directSources) {
			const record = asRecord(item);
			const title = asString(record?.title);
			const url = asString(record?.url) ?? asString(record?.host) ?? asString(record?.domain) ?? "";
			if (title) addSource(title, url);
		}
	}

	if (Array.isArray(details?.curatedQueries)) {
		for (const cq of details.curatedQueries) {
			const cqRecord = asRecord(cq);
			if (Array.isArray(cqRecord?.sources)) {
				for (const item of cqRecord.sources) {
					const record = asRecord(item);
					const title = asString(record?.title);
					const url = asString(record?.url) ?? "";
					if (title) addSource(title, url);
				}
			}
		}
	}

	if (sources.length === 0 && rawText) {
		const numberedPattern = /^\d+\.\s+(\S[^\n]*)\n\s+(https?:\/\/\S+)/gm;
		for (let match = numberedPattern.exec(rawText); match !== null; match = numberedPattern.exec(rawText)) {
			addSource(match[1]!, match[2]!);
		}
	}

	if (sources.length === 0 && rawText) {
		const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
		for (let match = markdownLinkPattern.exec(rawText); match !== null; match = markdownLinkPattern.exec(rawText)) {
			addSource(match[1]!, match[2]!);
		}
	}

	return sources;
}

export function formatWebSearchDetailLines(
	rawText: string,
	details: Record<string, unknown> | undefined,
	expanded: boolean,
): string[] {
	const sources = parseWebSearchSources(rawText, details);
	const totalResults = asNumber(details?.totalResults) ?? sources.length;
	const summary = theme.fg("text", `${theme.bold(String(totalResults))} ${totalResults === 1 ? "result" : "results"}`);

	if (sources.length > 0) {
		const sourceRows = sources.map((source) =>
			source.host
				? `${theme.fg("toolOutput", source.title)}${theme.fg("dim", ` · ${source.host}`)}`
				: theme.fg("toolOutput", source.title),
		);
		if (!expanded) {
			return [summary, ...collapseToolBlockLines(sourceRows, TOOL_BLOCK_LIMITS.web, false)];
		}
		const extraLines = splitContentLines(rawText)
			.map((line) => line.trimEnd())
			.filter(
				(line) =>
					line.trim() !== "" &&
					line.trim() !== "---" &&
					line.trim() !== "**Sources:**" &&
					!/^\d+\.\s+/.test(line.trim()) &&
					!/^https?:\/\/\S+$/.test(line.trim()),
			)
			.map((line) => theme.fg("toolOutput", replaceTabs(line)));
		return [summary, ...sourceRows, ...extraLines];
	}

	const fallbackRows = splitContentLines(rawText)
		.map((line) => line.trim())
		.filter((line) => line !== "" && line !== "---" && !line.startsWith("[") && line !== "No results found.")
		.map((line) => theme.fg("toolOutput", replaceTabs(line)));

	if (fallbackRows.length === 0) {
		return [summary];
	}
	return [summary, ...collapseToolBlockLines(fallbackRows, TOOL_BLOCK_LIMITS.web, expanded)];
}

function formatWebSearchArgs(
	argsRecord: Record<string, unknown> | undefined,
	details: Record<string, unknown> | undefined,
): string {
	const single = asString(argsRecord?.query)?.trim();
	if (single) return singleLineDisplayText(single);
	const list = Array.isArray(argsRecord?.queries)
		? argsRecord.queries
		: Array.isArray(details?.queries)
			? details.queries
			: [];
	const cleaned = list.map((item) => singleLineDisplayText(String(item ?? "")).trim()).filter(Boolean);
	return cleaned.join(" · ");
}

function presentWebSearch(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const details = asRecord(input.result?.details);
	const display = formatWebSearchArgs(argsRecord, details);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: true });

	if (isWaitingForApproval(input)) {
		return { title: "WebSearch", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "WebSearch", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "WebSearch",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (details?.cancelled === true || isInterruptedResult(input.result)) {
		return {
			title: "WebSearch",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	const errorDetail = asString(details?.error);
	if (input.result?.isError || errorDetail) {
		const errorText = terminalDisplayText(errorDetail ?? rawText).replace(/^Error:\s*/i, "");
		return {
			title: "WebSearch",
			args: display,
			status: "failure",
			meta: ["failed", ...(elapsed ? [elapsed] : [])],
			details: errorText ? new ToolBlockLines([theme.fg("error", errorText)]) : undefined,
		};
	}

	return {
		title: "WebSearch",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines(formatWebSearchDetailLines(rawText, details, input.expanded), input.expanded),
	};
}

export function formatFetchDetailLines(
	rawText: string,
	details: Record<string, unknown> | undefined,
	expanded: boolean,
	urlHint = "",
): string[] {
	const bytes =
		asNumber(details?.bytes) ??
		asNumber(details?.sizeBytes) ??
		asNumber(details?.totalChars) ??
		Buffer.byteLength(rawText, "utf8");
	const format =
		asString(details?.format) ??
		(details?.frames !== undefined || details?.timestamp !== undefined || typeof details?.duration === "number"
			? "video"
			: /\.pdf(?:$|[?#])/i.test(urlHint)
				? "pdf"
				: "markdown");
	const summary = `${theme.fg("text", `Fetched ${theme.bold(formatToolBlockByteSize(bytes))}`)}${theme.fg("dim", ` · ${format}`)}`;
	if (!expanded) {
		return [summary];
	}
	const bodyLines = splitContentLines(rawText).map((line) => theme.fg("toolOutput", replaceTabs(line)));
	return [summary, ...bodyLines];
}

function formatFetchArgs(
	argsRecord: Record<string, unknown> | undefined,
	details: Record<string, unknown> | undefined,
): string {
	const urls = Array.isArray(argsRecord?.urls)
		? argsRecord.urls
		: typeof argsRecord?.url === "string"
			? [argsRecord.url]
			: Array.isArray(details?.urls)
				? details.urls
				: [];
	return urls
		.map((entry) => stripUrlScheme(String(entry ?? "")))
		.filter(Boolean)
		.join(", ");
}

function presentFetch(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation {
	const argsRecord = asRecord(input.args);
	const details = asRecord(input.result?.details);
	const display = formatFetchArgs(argsRecord, details);
	const isRunning = !input.result || input.isPartial;
	const elapsed = formatToolBlockElapsed(resolveDurationMs(input), { isRunning, subTenDecimal: true });

	if (isWaitingForApproval(input)) {
		return { title: "Fetch", args: display, status: "warning", meta: ["waiting for approval"] };
	}
	if (isRunning) {
		return { title: "Fetch", args: display, status: "running", meta: elapsed ? [elapsed] : undefined };
	}
	if (isRejectedResult(input)) {
		return {
			title: "Fetch",
			args: display,
			status: "stopped",
			meta: ["rejected"],
			details: new ToolBlockLines([theme.fg("muted", "Not run")]),
		};
	}
	if (isInterruptedResult(input.result)) {
		return {
			title: "Fetch",
			args: display,
			status: "stopped",
			meta: [elapsed ? `interrupted after ${elapsed}` : "interrupted"],
		};
	}

	const rawText = extractRawText(input.result);
	const errorDetail = asString(details?.error);
	if (input.result?.isError || details?.outcome === "all_failed" || errorDetail) {
		const errorText = terminalDisplayText(errorDetail ?? rawText).replace(/^Error:\s*/i, "");
		const firstLine = splitContentLines(errorText)[0] ?? "Fetch failed";
		return {
			title: "Fetch",
			args: display,
			status: "failure",
			meta: ["failed", ...(elapsed ? [elapsed] : [])],
			details: new ToolBlockLines([theme.fg("error", firstLine)]),
		};
	}

	return {
		title: "Fetch",
		args: display,
		status: "success",
		meta: elapsed ? [elapsed] : undefined,
		details: new ToolBlockLines(formatFetchDetailLines(rawText, details, input.expanded, display), input.expanded),
	};
}

function baseBuiltinToolBlockPresentation(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation | undefined {
	if (input.toolName === "powershell") {
		const shell = presentBash(input);
		return { ...shell, title: shell.title === "Wait" ? "Wait" : "PowerShell" };
	}
	switch (input.toolName) {
		case "read":
			return presentRead(input);
		case "search":
		case "grep":
			return presentSearch(input);
		case "find":
			return presentFind(input);
		case "ls":
			return presentList(input);
		case "bash":
			return presentBash(input);
		case "wait":
			return presentWait(input);
		case "edit":
			return presentEdit(input);
		case "write":
			return presentWrite(input);
		case "todo":
			return presentTodo(input);
		case "web_search":
			return presentWebSearch(input);
		case "fetch_content":
			return presentFetch(input);
		default:
			return undefined;
	}
}

export function builtinToolBlockPresentation(input: BuiltinToolBlockInput): BuiltinToolBlockPresentation | undefined {
	const view = baseBuiltinToolBlockPresentation(input);
	if (!view || !["bash", "powershell", "wait"].includes(input.toolName)) return view;
	const details = asRecord(input.result?.details);
	const path = asString(details?.fullOutputPath);
	if (!path) return view;
	const truncation = asRecord(details?.truncation);
	const total = asNumber(truncation?.totalLines);
	const retained = asNumber(truncation?.outputLines);
	const label =
		total !== undefined && retained !== undefined
			? `Truncated: showing ${retained} of ${total} lines. Full output:`
			: "Full output:";
	return {
		...view,
		details: new ToolBlockRecords([
			...(view.details ? [view.details] : []),
			new ToolBlockLines([theme.fg("dim", label)], true),
			new ToolBlockLines([linkPath(path, terminalDisplayText(path), input.cwd)], true),
		]),
	};
}
