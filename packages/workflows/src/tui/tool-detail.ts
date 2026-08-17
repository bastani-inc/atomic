/** Read-only host-style operator tool message renderer for a durable `ctx.tool` graph node. */
import type { ToolNodeSnapshot, ToolNodeStatus } from "../shared/store-types.js";
import type { ToolPayloadValue } from "../shared/tool-payload-bounds.js";
import {
	boundedToolPayloadText,
	boundedToolText,
	sanitizeToolDisplayText,
	sanitizeToolTitleText,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../shared/tool-payload-bounds.js";
import { BOLD, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { graphemes, truncateToWidth, visibleWidth } from "./text-helpers.js";

/** Maximum serialized value retained by the detail display before its marker. */
export const TOOL_DETAIL_VALUE_LIMIT = TOOL_PAYLOAD_VALUE_LIMIT;
const COLLAPSED_ARGS_LIMIT = 240;
const COLLAPSED_RESULT_LIMIT = 320;
/** Match the host tool renderer's collapsed fallback preview row bound. */
const COLLAPSED_RESULT_LINES = 10;
const BODY_INDENT = "  ";

export interface RenderToolDetailOpts {
	/** Provide for ANSI output; omit for plain text. */
	theme?: GraphTheme;
	/** Message-block width in terminal cells. */
	width?: number;
	/** Clock used for a still-running node's derived duration. */
	now?: number;
	/** Full metadata is opt-in; graph-opened blocks pass false until expanded. */
	expanded?: boolean;
	/** Configured display text for the expand action, normally `ctrl+o`. */
	expandKey?: string;
}

function statusColor(status: ToolNodeStatus, theme: GraphTheme): string {
	switch (status) {
		case "running":
			return theme.warning;
		case "completed":
			return theme.success;
		case "failed":
			return theme.error;
		case "cached":
			return theme.info;
		case "cancelled":
			return theme.dim;
		default:
			return theme.dim;
	}
}

function statusGlyph(status: ToolNodeStatus): string {
	switch (status) {
		case "running":
			return "●";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cached":
			return "↻";
		case "cancelled":
			return "⊘";
		default:
			return "○";
	}
}

/** Completed calls already read like `$ name`; other states retain a quiet status marker. */
function headerGlyph(status: ToolNodeStatus): string | undefined {
	return status === "completed" ? undefined : statusGlyph(status);
}

function styledStatus(status: ToolNodeStatus, theme: GraphTheme | undefined): string {
	const glyph = statusGlyph(status);
	return theme === undefined ? glyph : `${hexToAnsi(statusColor(status, theme))}${glyph}${RESET}`;
}

function styledTitle(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.text)}${BOLD}${text}${RESET}`;
}

function styledMuted(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.textMuted)}${text}${RESET}`;
}

function styledError(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.error)}${text}${RESET}`;
}

function toolBackground(status: ToolNodeStatus, theme: GraphTheme): string {
	switch (status) {
		case "completed":
		case "cached":
			return theme.backgroundToolSuccess;
		case "failed":
		case "cancelled":
			return theme.backgroundToolError;
		default:
			return theme.backgroundPanel;
	}
}

function boundedSerializedValue(value: ToolPayloadValue | undefined, limit = TOOL_DETAIL_VALUE_LIMIT): string {
	if (value === undefined) return "—";
	return boundedToolPayloadText(value, limit);
}

function durationMs(tool: ToolNodeSnapshot, now: number): number | undefined {
	if (tool.durationMs !== undefined) return Math.max(0, tool.durationMs);
	if (tool.startedAt === undefined) return undefined;
	const end = tool.endedAt ?? (tool.status === "running" ? now : undefined);
	return end === undefined ? undefined : Math.max(0, end - tool.startedAt);
}

function resultValue(tool: ToolNodeSnapshot): ToolPayloadValue | undefined {
	if (tool.result !== undefined) return tool.result;
	if (tool.resultSummary !== undefined) return tool.resultSummary;
	return undefined;
}

function boundedErrorText(value: string, limit: number): string {
	const safe = sanitizeToolDisplayText(value);
	if (safe.length <= limit) return safe;
	const keep = Math.max(0, limit - TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return `${safe.slice(-keep)}${TOOL_PAYLOAD_TRUNCATION_MARKER}`;
}
function resultText(tool: ToolNodeSnapshot, limit: number): { text: string; error: boolean } {
	if (tool.error !== undefined) {
		return { text: boundedErrorText(tool.error, limit), error: true };
	}
	return { text: boundedSerializedValue(resultValue(tool), limit), error: false };
}

/** A punctuation-aware break point. Paths and JSON punctuation are natural terminal seams. */
function isWrapBoundary(grapheme: string): boolean {
	return /[\s/\\.,:;()[\]{}"'`=+|!?<>-]/u.test(grapheme);
}
/**
 * Wrap text at punctuation, path separators, or whitespace without splitting a
 * component in the middle. A component wider than the available row is shown
 * with an ellipsis rather than broken into misleading fragments.
 */
function wrapPreserving(text: string, width: number): string[] {
	const budget = Math.max(1, Math.floor(width));
	const rows: string[] = [];
	for (const paragraph of text.split("\n")) {
		let remaining = paragraph;
		if (remaining.length === 0) {
			rows.push("");
			continue;
		}
		while (remaining.length > 0) {
			if (visibleWidth(remaining) <= budget) {
				rows.push(remaining);
				remaining = "";
				break;
			}

			let offset = 0;
			let lastBoundary = 0;
			let currentWidth = 0;
			for (const grapheme of graphemes(remaining)) {
				const graphemeWidth = visibleWidth(grapheme);
				if (currentWidth + graphemeWidth > budget) break;
				offset += grapheme.length;
				currentWidth += graphemeWidth;
				if (isWrapBoundary(grapheme)) lastBoundary = offset;
			}

			if (offset === 0) {
				rows.push("…");
				const firstBoundary = [...graphemes(remaining)].findIndex(isWrapBoundary);
				remaining = firstBoundary < 0 ? "" : remaining.slice(firstBoundary + 1);
				continue;
			}
			if (lastBoundary > 0) {
				rows.push(remaining.slice(0, lastBoundary));
				remaining = remaining.slice(lastBoundary);
				continue;
			}

			// No punctuation or whitespace fit in this row: truncate the single
			// overlong component instead of splitting it across terminal rows.
			const nextBoundary = [...graphemes(remaining)].findIndex(isWrapBoundary);
			const componentEnd =
				nextBoundary < 0 ? remaining.length : [...graphemes(remaining)].slice(0, nextBoundary + 1).join("").length;
			const component = remaining.slice(0, componentEnd);
			const ellipsisWidth = visibleWidth("…");
			let prefix = "";
			for (const grapheme of graphemes(component)) {
				if (visibleWidth(prefix) + visibleWidth(grapheme) + ellipsisWidth > budget) break;
				prefix += grapheme;
			}
			rows.push(`${prefix}…`);
			remaining = remaining.slice(componentEnd);
		}
	}
	return rows.length > 0 ? rows : [""];
}

/** Keep a generated truncation marker intact when a field wraps at its cap. */
function wrapFieldValue(text: string, width: number): string[] {
	if (!text.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER)) return wrapPreserving(text, width);
	const body = text.slice(0, -TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return [...wrapPreserving(body, width), TOOL_PAYLOAD_TRUNCATION_MARKER];
}

function fitLine(text: string, width: number, suffix: string, theme: GraphTheme | undefined): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return theme === undefined
		? visibleWidth(text) <= safeWidth
			? text
			: truncateToWidth(text, safeWidth, suffix, true)
		: truncateToWidth(text, safeWidth, suffix, true);
}

/** Paint the complete row, including its trailing fill, with the tool status background. */
function paintRow(content: string, width: number, theme: GraphTheme | undefined, status: ToolNodeStatus): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const fitted = fitLine(content, safeWidth, "…", theme);
	if (theme === undefined) return fitted;
	const padding = Math.max(0, safeWidth - visibleWidth(fitted));
	const background = hexBg(toolBackground(status, theme));
	return `${background}${fitted}${background}${" ".repeat(padding)}${RESET}`;
}

function messageHeaderRows(
	tool: ToolNodeSnapshot,
	width: number,
	theme: GraphTheme | undefined,
	expanded: boolean,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const name = sanitizeToolTitleText(tool.name);
	const glyph = headerGlyph(tool.status);
	const glyphSuffix = glyph === undefined ? "" : ` ${glyph}`;
	const args =
		tool.args === undefined
			? ""
			: boundedSerializedValue(tool.args, expanded ? TOOL_DETAIL_VALUE_LIMIT : COLLAPSED_ARGS_LIMIT);
	const withArgs = `$ ${name}${args ? ` ${args}` : ""}${glyphSuffix}`;
	const plain = !expanded && visibleWidth(withArgs) > safeWidth ? `$ ${name}${glyphSuffix}` : withArgs;
	const titleEnd = `$ ${name}`;
	return wrapFieldValue(plain, safeWidth).map((chunk, index, chunks) => {
		if (index !== 0 || !chunk.startsWith(titleEnd)) return styledMuted(chunk, theme);
		const remainder = chunk.slice(titleEnd.length);
		const hasStatus = glyphSuffix.length > 0 && index === chunks.length - 1 && remainder.endsWith(glyphSuffix);
		const summary = hasStatus ? remainder.slice(0, -glyphSuffix.length) : remainder;
		const suffix = hasStatus ? ` ${styledStatus(tool.status, theme)}` : "";
		return `${styledTitle(titleEnd, theme)}${summary.trim().length > 0 ? styledMuted(summary, theme) : ""}${suffix}`;
	});
}

function bodyRows(text: string, error: boolean, width: number, theme: GraphTheme | undefined): string[] {
	const contentWidth = Math.max(1, width - visibleWidth(BODY_INDENT));
	return wrapFieldValue(text, contentWidth).map((line) => {
		const styled = error ? styledError(line, theme) : styledMuted(line, theme);
		return `${BODY_INDENT}${styled}`;
	});
}

function footerText(tool: ToolNodeSnapshot, elapsed: number | undefined): string | undefined {
	if (elapsed === undefined) return undefined;
	const label = tool.status === "running" ? "Elapsed" : "Took";
	const duration = elapsed < 1000 ? `${Math.round(elapsed)}ms` : fmtDuration(elapsed);
	const markers = [
		tool.status === "cached" ? "cached" : undefined,
		tool.replayed === true ? "replayed" : undefined,
	].filter((marker): marker is string => marker !== undefined);
	return `${label} ${duration}${markers.length > 0 ? ` · ${markers.join(" · ")}` : ""}`;
}

function renderMessageLines(
	tool: ToolNodeSnapshot,
	width: number,
	theme: GraphTheme | undefined,
	expanded: boolean,
	expandKey: string,
	now: number,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const result = resultText(tool, expanded ? TOOL_DETAIL_VALUE_LIMIT : COLLAPSED_RESULT_LIMIT);
	const rows: string[] = messageHeaderRows(tool, safeWidth, theme, expanded);
	const wrappedBody = bodyRows(result.text, result.error, safeWidth, theme);
	if (expanded) {
		rows.push(...wrappedBody);
		if (tool.source !== undefined && tool.source.length > 0) {
			const sourceWidth = Math.max(1, safeWidth - visibleWidth(BODY_INDENT));
			rows.push(
				...wrapFieldValue(boundedToolText(sanitizeToolDisplayText(tool.source)), sourceWidth).map(
					(line) => `${BODY_INDENT}${styledMuted(line, theme)}`,
				),
			);
		}
	} else {
		const earlier = Math.max(0, wrappedBody.length - COLLAPSED_RESULT_LINES);
		if (earlier > 0) {
			const hint =
				expandKey.length > 0
					? `... (${earlier} earlier lines, ${expandKey} Expand)`
					: `... (${earlier} earlier lines)`;
			rows.push(`  ${styledMuted(hint, theme)}`);
		}
		rows.push(...wrappedBody.slice(-COLLAPSED_RESULT_LINES));
	}
	const footer = footerText(tool, durationMs(tool, now));
	if (footer !== undefined) rows.push(styledMuted(footer, theme));
	return rows.map((row) => paintRow(row, safeWidth, theme, tool.status));
}

/** Render one read-only host-style operator tool message block. */
export function renderToolDetail(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string {
	const width = Math.max(1, Math.floor(opts.width ?? 80));
	const expandKey = opts.expandKey ?? "ctrl+o";
	return renderMessageLines(tool, width, opts.theme, opts.expanded === true, expandKey, opts.now ?? Date.now()).join(
		"\n",
	);
}

/** Render message-block lines for graph-body composition. */
export function renderToolDetailLines(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string[] {
	return renderToolDetail(tool, opts).split("\n");
}
