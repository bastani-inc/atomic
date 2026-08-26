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
import { graphemeSegments, graphemes, truncateToWidth, visibleWidth } from "./text-helpers.js";

/** Maximum serialized value retained by the detail display before its marker. */
export const TOOL_DETAIL_VALUE_LIMIT = TOOL_PAYLOAD_VALUE_LIMIT;
const COLLAPSED_ARGS_LIMIT = 240;
/** Match the host tool renderer's collapsed fallback preview row bound. */
const COLLAPSED_RESULT_LINES = 10;
/** Match pi-tui `Box(paddingX=1, paddingY=1)` around the host tool card. */
const BOX_PAD = 1;

function boxMetrics(width: number): { pad: string; inner: number } {
	const safeWidth = Math.max(1, Math.floor(width));
	const inset = safeWidth >= BOX_PAD * 2 + 1 ? BOX_PAD : 0;
	return { pad: " ".repeat(inset), inner: Math.max(1, safeWidth - inset * 2) };
}

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

/** Running and completed calls already read like `$ name`; other states retain a quiet status marker. */
function statusGlyph(status: ToolNodeStatus): string | undefined {
	switch (status) {
		case "running":
		case "completed":
			return undefined;
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
	if (glyph === undefined) return "";
	return theme === undefined ? glyph : `${hexToAnsi(statusColor(status, theme))}${glyph}${RESET}`;
}

function styledTitle(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.toolTitle)}${BOLD}${text}${RESET}`;
}

function styledOutput(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.toolOutput)}${text}${RESET}`;
}

function styledMuted(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.textMuted)}${text}${RESET}`;
}

function styledDim(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.dim)}${text}${RESET}`;
}

function styledError(text: string, theme: GraphTheme | undefined): string {
	return theme === undefined ? text : `${hexToAnsi(theme.error)}${text}${RESET}`;
}

function expandHintLine(earlier: number, expandKey: string, pad: string, theme: GraphTheme | undefined): string {
	const lead = `... (${earlier} earlier lines`;
	if (expandKey.length === 0) return `${pad}${styledMuted(`${lead})`, theme)}`;
	return `${pad}${styledMuted(`${lead}, `, theme)}${styledDim(expandKey, theme)}${styledMuted(" Expand)", theme)}`;
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

function resultText(tool: ToolNodeSnapshot, limit: number): { text: string; error: boolean } {
	if (tool.error !== undefined) {
		return { text: boundedToolText(sanitizeToolDisplayText(tool.error), limit), error: true };
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
function wrapPreserving(text: string, width: number, continuationWidth = width): string[] {
	const firstBudget = Math.max(1, Math.floor(width));
	const followingBudget = Math.max(1, Math.floor(continuationWidth));
	const rows: string[] = [];
	for (const paragraph of text.split("\n")) {
		const segments = graphemeSegments(paragraph);
		if (segments.length === 0) {
			rows.push("");
			continue;
		}
		const segmentWidths = segments.map(({ segment }) => visibleWidth(segment));
		const suffixWidths = new Array<number>(segments.length + 1).fill(0);
		for (let index = segments.length - 1; index >= 0; index--) {
			suffixWidths[index] = suffixWidths[index + 1]! + segmentWidths[index]!;
		}
		let segmentIndex = 0;
		while (segmentIndex < segments.length) {
			const budget = rows.length === 0 ? firstBudget : followingBudget;
			if (suffixWidths[segmentIndex]! <= budget) {
				rows.push(paragraph.slice(segments[segmentIndex]!.index));
				break;
			}

			let scanIndex = segmentIndex;
			let currentWidth = 0;
			let lastBoundary = segmentIndex;
			while (scanIndex < segments.length) {
				const graphemeWidth = segmentWidths[scanIndex]!;
				if (currentWidth + graphemeWidth > budget) break;
				currentWidth += graphemeWidth;
				scanIndex += 1;
				if (isWrapBoundary(segments[scanIndex - 1]!.segment)) lastBoundary = scanIndex;
			}

			if (scanIndex === segmentIndex) {
				rows.push("…");
				// Skip only the oversized grapheme. Leave a following wrap
				// boundary unconsumed so `👍/next` can still render `/next`.
				segmentIndex += 1;
				continue;
			}
			if (lastBoundary > segmentIndex) {
				const endOffset = lastBoundary < segments.length ? segments[lastBoundary]!.index : paragraph.length;
				rows.push(paragraph.slice(segments[segmentIndex]!.index, endOffset));
				segmentIndex = lastBoundary;
				continue;
			}

			// No punctuation or whitespace fit in this row: truncate the single
			// overlong component instead of splitting it across terminal rows.
			// Leave a following wrap boundary unconsumed so `abcdef/next` keeps
			// the `/` for the next row instead of dropping it with the ellipsis.
			let componentEnd = segmentIndex;
			while (componentEnd < segments.length && !isWrapBoundary(segments[componentEnd]!.segment)) componentEnd += 1;
			const ellipsisWidth = visibleWidth("…");
			let prefix = "";
			let prefixWidth = 0;
			for (let index = segmentIndex; index < componentEnd; index++) {
				const grapheme = segments[index]!.segment;
				const graphemeWidth = segmentWidths[index]!;
				if (prefixWidth + graphemeWidth + ellipsisWidth > budget) break;
				prefix += grapheme;
				prefixWidth += graphemeWidth;
			}
			rows.push(`${prefix}…`);
			segmentIndex = componentEnd;
		}
	}
	return rows.length > 0 ? rows : [""];
}

function wrapFieldValue(text: string, width: number, continuationWidth = width): string[] {
	if (!text.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER)) return wrapPreserving(text, width, continuationWidth);
	const body = text.slice(0, -TOOL_PAYLOAD_TRUNCATION_MARKER.length);
	return [...wrapPreserving(body, width, continuationWidth), TOOL_PAYLOAD_TRUNCATION_MARKER];
}

function fitLine(text: string, width: number, suffix: string, theme: GraphTheme | undefined): string {
	const safeWidth = Math.max(1, Math.floor(width));
	if (theme !== undefined) return truncateToWidth(text, safeWidth, suffix, true);
	if (visibleWidth(text) <= safeWidth) return text;
	const suffixWidth = visibleWidth(suffix);
	const budget = Math.max(0, safeWidth - suffixWidth);
	let output = "";
	let outputWidth = 0;
	for (const grapheme of graphemes(text)) {
		const graphemeWidth = visibleWidth(grapheme);
		if (outputWidth + graphemeWidth > budget) break;
		output += grapheme;
		outputWidth += graphemeWidth;
	}
	return `${output}${suffix}`;
}

/** Paint the complete row, including its trailing fill, with the tool status background. */
function paintRow(content: string, width: number, theme: GraphTheme | undefined, status: ToolNodeStatus): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const fitted = fitLine(content, safeWidth, "…", theme);
	if (theme === undefined) return fitted;
	const padding = Math.max(0, safeWidth - visibleWidth(fitted));
	const background = hexBg(toolBackground(status, theme));
	const repainted = fitted.replaceAll(RESET, `${RESET}${background}`);
	return `${background}${repainted}${background}${" ".repeat(padding)}${RESET}`;
}

function messageHeaderRows(
	tool: ToolNodeSnapshot,
	width: number,
	theme: GraphTheme | undefined,
	expanded: boolean,
): string[] {
	const { pad, inner } = boxMetrics(width);
	const name = sanitizeToolTitleText(tool.name);
	const glyph = statusGlyph(tool.status);
	const glyphSuffix = glyph === undefined ? "" : ` ${glyph}`;
	const args =
		tool.args === undefined
			? ""
			: boundedSerializedValue(tool.args, expanded ? TOOL_DETAIL_VALUE_LIMIT : COLLAPSED_ARGS_LIMIT);
	const withArgs = `$ ${name}${args ? ` ${args}` : ""}${glyphSuffix}`;
	const plain = !expanded && visibleWidth(withArgs) > inner ? `$ ${name}${glyphSuffix}` : withArgs;
	const titleEnd = `$ ${name}`;
	return wrapFieldValue(plain, inner, inner).map((chunk, index, chunks) => {
		if (index !== 0 || !chunk.startsWith(titleEnd)) return `${pad}${styledMuted(chunk, theme)}`;
		const remainder = chunk.slice(titleEnd.length);
		const hasStatus = glyphSuffix.length > 0 && index === chunks.length - 1 && remainder.endsWith(glyphSuffix);
		const summary = hasStatus ? remainder.slice(0, -glyphSuffix.length) : remainder;
		const suffix = hasStatus ? ` ${styledStatus(tool.status, theme)}` : "";
		const title = styledTitle(titleEnd, theme);
		const rest = summary.trim().length > 0 ? styledMuted(summary, theme) : "";
		return `${pad}${title}${rest}${suffix}`;
	});
}

function bodyRows(text: string, error: boolean, width: number, theme: GraphTheme | undefined): string[] {
	const { pad, inner } = boxMetrics(width);
	return wrapFieldValue(text, inner).map((line) => {
		const styled = error ? styledError(line, theme) : styledOutput(line, theme);
		return `${pad}${styled}`;
	});
}

function footerText(tool: ToolNodeSnapshot, elapsed: number | undefined): string | undefined {
	if (elapsed === undefined) return undefined;
	const label = tool.status === "running" ? "Elapsed" : "Took";
	const markers = [
		tool.status === "cached" ? "cached" : undefined,
		tool.replayed === true ? "replayed" : undefined,
	].filter((marker): marker is string => marker !== undefined);
	return `${label} ${fmtDuration(elapsed)}${markers.length > 0 ? ` · ${markers.join(" · ")}` : ""}`;
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
	const { pad, inner } = boxMetrics(safeWidth);
	const result = resultText(tool, TOOL_DETAIL_VALUE_LIMIT);
	const rows: string[] = messageHeaderRows(tool, safeWidth, theme, expanded);
	// Host bash/result renderers put a blank row between the `$` call and the body.
	rows.push("");
	const wrappedBody = bodyRows(result.text, result.error, safeWidth, theme);
	if (expanded) {
		rows.push(...wrappedBody);
		if (tool.source !== undefined && tool.source.length > 0) {
			rows.push(
				...wrapFieldValue(boundedToolText(sanitizeToolDisplayText(tool.source)), inner).map(
					(line) => `${pad}${styledMuted(line, theme)}`,
				),
			);
		}
	} else {
		const earlier = Math.max(0, wrappedBody.length - COLLAPSED_RESULT_LINES);
		if (earlier > 0) {
			rows.push(expandHintLine(earlier, expandKey, pad, theme));
		}
		rows.push(...wrappedBody.slice(-COLLAPSED_RESULT_LINES));
	}
	const footer = footerText(tool, durationMs(tool, now));
	if (footer !== undefined) {
		rows.push("");
		rows.push(`${pad}${styledMuted(footer, theme)}`);
	}
	const painted = rows.map((row) => paintRow(row, safeWidth, theme, tool.status));
	const padRow = paintRow("", safeWidth, theme, tool.status);
	return [padRow, ...painted, padRow];
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
