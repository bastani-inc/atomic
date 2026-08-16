/** Read-only agent-chat-style tool message renderer for a durable `ctx.tool` graph node. */
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
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { graphemes, truncateToWidth, visibleWidth } from "./text-helpers.js";

/** Maximum serialized value retained by the detail display before its marker. */
export const TOOL_DETAIL_VALUE_LIMIT = TOOL_PAYLOAD_VALUE_LIMIT;
const COLLAPSED_ARGS_LIMIT = 240;
const COLLAPSED_RESULT_LIMIT = 320;
const DETAIL_LABEL_WIDTH = 10;

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

function styledStatus(status: ToolNodeStatus, theme: GraphTheme | undefined): string {
	const glyph = statusGlyph(status);
	return theme === undefined ? glyph : `${hexToAnsi(statusColor(status, theme))}${glyph}${RESET}`;
}

function styledName(name: string, theme: GraphTheme | undefined): string {
	const safe = sanitizeToolTitleText(name);
	return theme === undefined ? safe : `${hexToAnsi(theme.text)}${BOLD}${safe}${RESET}`;
}

function styledMuted(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.textMuted)}${text}${RESET}`;
}

function styledError(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.error)}${text}${RESET}`;
}

function boundedSerializedValue(value: ToolPayloadValue | undefined, limit = TOOL_DETAIL_VALUE_LIMIT): string {
	if (value === undefined) return "—";
	return boundedToolPayloadText(value, limit);
}

/** Wrap text to visible columns without changing ordering, spaces, or duplicates. */
function wrapPreserving(text: string, width: number): string[] {
	const budget = Math.max(1, Math.floor(width));
	const rows: string[] = [];
	let row = "";
	for (const grapheme of graphemes(text)) {
		if (grapheme === "\n") {
			rows.push(row);
			row = "";
			continue;
		}
		if (row.length > 0 && visibleWidth(row) + visibleWidth(grapheme) > budget) {
			rows.push(row);
			row = "";
		}
		row += grapheme;
	}
	rows.push(row);
	return rows;
}

/** Keep a generated truncation marker intact when a field wraps at its cap. */
function wrapFieldValue(text: string, width: number): string[] {
	if (!text.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER)) return wrapPreserving(text, width);
	const body = text.slice(0, -TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return [...wrapPreserving(body, width), TOOL_PAYLOAD_TRUNCATION_MARKER];
}

function fitLine(text: string, width: number, suffix: string, theme: GraphTheme | undefined): string {
	const safeWidth = Math.max(1, Math.floor(width));
	if (theme !== undefined) return truncateToWidth(text, safeWidth, suffix, true);
	if (visibleWidth(text) <= safeWidth) return text;
	const suffixWidth = visibleWidth(suffix);
	const budget = Math.max(0, safeWidth - suffixWidth);
	let output = "";
	for (const grapheme of graphemes(text)) {
		if (visibleWidth(output) + visibleWidth(grapheme) > budget) break;
		output += grapheme;
	}
	return `${output}${suffix}`;
}

function labelPrefix(label: string, theme: GraphTheme | undefined): string {
	const padded = label.padEnd(DETAIL_LABEL_WIDTH, " ");
	return theme === undefined ? padded : `${hexToAnsi(theme.textMuted)}${BOLD}${padded}${RESET}`;
}

function textRows(label: string, text: string, width: number, theme: GraphTheme | undefined): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const valueWidth = Math.max(1, safeWidth - DETAIL_LABEL_WIDTH);
	return wrapFieldValue(text, valueWidth).map((chunk, index) => {
		const prefix = index === 0 ? labelPrefix(label, theme) : " ".repeat(Math.min(DETAIL_LABEL_WIDTH, safeWidth));
		return fitLine(`${prefix}${chunk}`, safeWidth, "…", theme);
	});
}

function scalarRow(label: string, value: string, width: number, theme: GraphTheme | undefined): string {
	return fitLine(`${labelPrefix(label, theme)}${value}`, Math.max(1, Math.floor(width)), "…", theme);
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

function compactResult(tool: ToolNodeSnapshot): { text: string; error: boolean } {
	if (tool.error !== undefined) {
		return { text: boundedToolText(sanitizeToolDisplayText(tool.error), COLLAPSED_RESULT_LIMIT), error: true };
	}
	return { text: boundedSerializedValue(resultValue(tool), COLLAPSED_RESULT_LIMIT), error: false };
}

function messageHeader(tool: ToolNodeSnapshot, width: number, theme: GraphTheme | undefined): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const args = tool.args === undefined ? "" : ` ${boundedSerializedValue(tool.args, COLLAPSED_ARGS_LIMIT)}`;
	const plain = `${statusGlyph(tool.status)} ${sanitizeToolTitleText(tool.name)}${args}`;
	if (visibleWidth(plain) <= safeWidth) {
		return `${styledStatus(tool.status, theme)} ${styledName(tool.name, theme)}${args ? ` ${styledMuted(args.slice(1), theme)}` : ""}`;
	}
	return fitLine(
		`${styledStatus(tool.status, theme)} ${styledName(tool.name, theme)}${args ? ` ${styledMuted(args.slice(1), theme)}` : ""}`,
		safeWidth,
		"…",
		theme,
	);
}

function compactMessageLines(
	tool: ToolNodeSnapshot,
	width: number,
	theme: GraphTheme | undefined,
	expandKey: string,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const result = compactResult(tool);
	const resultGlyph = styledStatus(tool.status, theme);
	const resultText = result.error ? styledError(result.text, theme) : styledMuted(result.text, theme);
	const rows = [
		messageHeader(tool, safeWidth, theme),
		fitLine(`  ${resultGlyph} ${resultText}`, safeWidth, "…", theme),
	];
	if (expandKey.length > 0) {
		rows.push(fitLine(`  ${styledMuted(`(${expandKey} to expand)`, theme)}`, safeWidth, "…", theme));
	}
	return rows;
}

function packSegments(segments: readonly string[], budget: number): string {
	const rows: string[] = [];
	let row = "";
	for (const segment of segments) {
		const candidate = row.length === 0 ? segment : `${row} · ${segment}`;
		if (row.length > 0 && visibleWidth(candidate) > budget) {
			rows.push(row);
			row = segment;
			continue;
		}
		row = candidate;
	}
	if (row.length > 0) rows.push(row);
	return rows.join("\n");
}

function expandedMessageLines(
	tool: ToolNodeSnapshot,
	width: number,
	theme: GraphTheme | undefined,
	expandKey: string,
	now: number,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const rows: string[] = [messageHeader(tool, safeWidth, theme)];
	rows.push(...textRows("ARGS", boundedSerializedValue(tool.args), safeWidth, theme));
	if (tool.error !== undefined)
		rows.push(...textRows("ERROR", boundedToolText(sanitizeToolDisplayText(tool.error)), safeWidth, theme));
	else rows.push(...textRows("RESULT", boundedSerializedValue(resultValue(tool)), safeWidth, theme));

	const source = tool.source === undefined ? "—" : boundedToolText(sanitizeToolDisplayText(tool.source));
	rows.push(...textRows("SOURCE", source, safeWidth, theme));
	const elapsed = durationMs(tool, now);
	const timing = packSegments(
		[
			`startedAt=${tool.startedAt ?? "—"}`,
			`endedAt=${tool.endedAt ?? "—"}`,
			`duration=${elapsed === undefined ? "—" : `${elapsed}ms (${fmtDuration(elapsed)})`}`,
		],
		Math.max(1, safeWidth - DETAIL_LABEL_WIDTH),
	);
	rows.push(...textRows("TIMING", timing, safeWidth, theme));
	const markers = [
		tool.status === "cached" ? "cached" : undefined,
		tool.replayed === true ? "replayed" : undefined,
	].filter((marker): marker is string => marker !== undefined);
	rows.push(scalarRow("MARKERS", markers.length > 0 ? markers.join(" · ") : "—", safeWidth, theme));
	if (expandKey.length > 0)
		rows.push(fitLine(`  ${styledMuted(`(${expandKey} to collapse)`, theme)}`, safeWidth, "…", theme));
	return rows;
}

/** Render one read-only agent-chat tool message block. */
export function renderToolDetail(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string {
	const width = Math.max(1, Math.floor(opts.width ?? 80));
	const expandKey = opts.expandKey ?? "ctrl+o";
	const rows =
		opts.expanded === true
			? expandedMessageLines(tool, width, opts.theme, expandKey, opts.now ?? Date.now())
			: compactMessageLines(tool, width, opts.theme, expandKey);
	return rows.join("\n");
}

/** Render message-block lines for graph-body composition. */
export function renderToolDetailLines(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string[] {
	return renderToolDetail(tool, opts).split("\n");
}
