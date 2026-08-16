/** Read-only detail renderer for a durable `ctx.tool` graph node. */
import type { ToolNodeSnapshot } from "../shared/store-types.js";
import {
	boundedToolPayloadText,
	boundedToolText,
	sanitizeToolDisplayText,
	sanitizeToolTitleText,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../shared/tool-payload-bounds.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import { renderRoundedBoxLines } from "./chat-surface.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { graphemes, truncateToWidth, visibleWidth } from "./text-helpers.js";

/** Maximum serialized value retained by the detail display before its marker. */
export const TOOL_DETAIL_VALUE_LIMIT = TOOL_PAYLOAD_VALUE_LIMIT;
const DETAIL_LABEL_WIDTH = 10;

export interface RenderToolDetailOpts {
	/** Provide for ANSI output; omit for plain text. */
	theme?: GraphTheme;
	/** Detail box width in terminal cells. */
	width?: number;
	/** Clock used for a still-running node's derived duration. */
	now?: number;
}

/**
 * Serialize one displayed field.
 *
 * The work is bounded by the display cap rather than by the payload, and a
 * hostile payload — cyclic, throwing `toJSON`, throwing getter — is contained
 * rather than thrown, so the view cannot crash on what a snapshot carries.
 */
function boundedSerializedValue(value: WorkflowSerializableValue | string | undefined): string {
	if (value === undefined) return "—";
	return boundedToolPayloadText(value, TOOL_DETAIL_VALUE_LIMIT);
}

/** Wrap a serialized value without collapsing spaces, ordering, or duplicates. */
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
	return rows.length > 0 ? rows : [""];
}

function labelPrefix(label: string, theme: GraphTheme | undefined): string {
	const padded = label.padEnd(DETAIL_LABEL_WIDTH, " ");
	return theme === undefined ? padded : `${hexToAnsi(theme.textMuted)}${BOLD}${padded}${RESET}`;
}

/** Lay one already-textual value out under its label, wrapping to the box. */
function textRows(label: string, text: string, innerWidth: number, theme: GraphTheme | undefined): string[] {
	const prefix = labelPrefix(label, theme);
	return wrapPreserving(text, Math.max(1, innerWidth - DETAIL_LABEL_WIDTH))
		.map((chunk, index) => `${index === 0 ? prefix : " ".repeat(DETAIL_LABEL_WIDTH)}${chunk}`)
		.map((row) => truncateToWidth(row, innerWidth, "…", theme !== undefined));
}

function valueRows(
	label: string,
	value: WorkflowSerializableValue | string | undefined,
	innerWidth: number,
	theme: GraphTheme | undefined,
): string[] {
	return textRows(label, boundedSerializedValue(value), innerWidth, theme);
}

function scalarRow(label: string, value: string, innerWidth: number, theme: GraphTheme | undefined): string {
	const prefix = labelPrefix(label, theme);
	return truncateToWidth(`${prefix}${value}`, innerWidth, "…", theme !== undefined);
}

/**
 * Pack whole segments onto rows.
 *
 * Timing is three separate facts, and cutting the row at the box edge made
 * `endedAt` and `duration` unreachable on a narrow terminal — the detail view
 * has no horizontal reveal. Each segment stays intact and moves to its own row
 * instead.
 */
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

function durationMs(tool: ToolNodeSnapshot, now: number): number | undefined {
	if (tool.durationMs !== undefined) return Math.max(0, tool.durationMs);
	if (tool.startedAt === undefined) return undefined;
	const end = tool.endedAt ?? (tool.status === "running" ? now : undefined);
	return end === undefined ? undefined : Math.max(0, end - tool.startedAt);
}

/** Render one read-only tool detail panel as a newline-delimited string. */
export function renderToolDetail(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string {
	const width = Math.max(32, opts.width ?? 80);
	const innerWidth = Math.max(2, width - 2);
	const theme = opts.theme;
	const now = opts.now ?? Date.now();
	const rows: string[] = [
		...valueRows("NAME", tool.name, innerWidth, theme),
		scalarRow("STATUS", tool.status, innerWidth, theme),
		...valueRows("ARGS", tool.args, innerWidth, theme),
	];
	if (tool.result !== undefined) rows.push(...valueRows("RESULT", tool.result, innerWidth, theme));
	else if (tool.resultSummary !== undefined) rows.push(...valueRows("RESULT", tool.resultSummary, innerWidth, theme));
	if (tool.error !== undefined) rows.push(...valueRows("ERROR", tool.error, innerWidth, theme));
	if (tool.result === undefined && tool.resultSummary === undefined && tool.error === undefined)
		rows.push(scalarRow("RESULT", "—", innerWidth, theme));

	// Source stays readable as source rather than JSON-quoted onto one line, so
	// it carries no escaping of its own: tabs and control bytes are neutralized
	// here or they would desynchronize the width model and paint live escape
	// sequences into the frame. Bounded first so the work stays capped.
	if (tool.source !== undefined) {
		const source = boundedToolText(sanitizeToolDisplayText(boundedToolText(tool.source, TOOL_DETAIL_VALUE_LIMIT)));
		rows.push(...textRows("SOURCE", source, innerWidth, theme));
	}

	const elapsed = durationMs(tool, now);
	const timing = packSegments(
		[
			`startedAt=${tool.startedAt ?? "—"}`,
			`endedAt=${tool.endedAt ?? "—"}`,
			`duration=${elapsed === undefined ? "—" : `${elapsed}ms (${fmtDuration(elapsed)})`}`,
		],
		Math.max(1, innerWidth - DETAIL_LABEL_WIDTH),
	);
	rows.push(...textRows("TIMING", timing, innerWidth, theme));
	const markers = [
		tool.status === "cached" ? "cached" : undefined,
		tool.replayed === true ? "replayed" : undefined,
	].filter((marker): marker is string => marker !== undefined);
	rows.push(scalarRow("MARKERS", markers.length > 0 ? markers.join(" · ") : "—", innerWidth, theme));

	return renderRoundedBoxLines({
		title: sanitizeToolTitleText(`TOOL ${tool.name}`),
		bodyLines: rows,
		width,
		...(theme !== undefined ? { theme, accent: theme.accent } : {}),
	}).join("\n");
}

/** Render detail lines for graph-body composition. */
export function renderToolDetailLines(tool: ToolNodeSnapshot, opts: RenderToolDetailOpts = {}): string[] {
	return renderToolDetail(tool, opts).split("\n");
}
