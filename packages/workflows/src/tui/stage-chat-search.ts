/**
 * Find-in-stage-chat.
 *
 * The fullscreen transcript gets its search from pi-tui. A stage chat is
 * Atomic's own surface rendered inside an overlay, so it needs its own — and
 * it must be *this* chat's search: `Ctrl+Shift+F` while a stage chat is
 * focused may never open a box over the main transcript hidden behind it.
 * Atomic's fullscreen action allowlist is what keeps the key here (L8); this
 * module is what it finds when it arrives.
 *
 * The corpus is the **whole** stage transcript, not the rows currently on
 * screen: `ChatSessionHost` measures and paints any absolute row range through
 * its body viewport, so a match hundreds of rows above the window is found and
 * then scrolled to. Matching itself is `findSearchMatches` from
 * `@bastani/atomic`, shared with any other surface Atomic searches.
 *
 * cross-ref:
 *  - packages/coding-agent/src/modes/interactive/components/transcript-search.ts
 *  - specs/2026-08-14-pi-0.84.2-migration.md §5.5
 */

import {
	findSearchMatches,
	getSearchMatchKey,
	highlightSearchMatchRow,
	type TranscriptSearchHighlightRange,
	type TranscriptSearchHighlightStyles,
	type TranscriptSearchMatch,
} from "@bastani/atomic";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { paint } from "./color-utils.js";
import { searchMatchColors } from "./graph-theme.js";
import { blankLine } from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

/** Rows the find bar occupies while it is open: title plus the query line. */
export const STAGE_CHAT_SEARCH_ROWS = 2;

/**
 * How the next refresh should pick a match.
 *
 * `query` re-anchors on the row the reader is nearest, `next`/`previous` step
 * from the current one, and `retain` keeps the selection where it is — which is
 * what every frame that is only a repaint asks for.
 */
type StageChatSearchSelectionMode = "query" | "next" | "previous" | "retain";

export interface StageChatSearchState {
	readonly input: Input;
	query: string;
	matches: readonly TranscriptSearchMatch[];
	selectedIndex: number;
	selectedKey: string | undefined;
	selectionMode: StageChatSearchSelectionMode;
	/** Row the selection is re-derived from when the query changes. */
	anchorRow: number;
	/** Corpus identity of the last match run, so a repaint does not re-match. */
	corpusKey: string;
}

/**
 * Open the find bar, anchored on the row the reader is parked on so the first
 * match chosen is the one nearest what they were already reading.
 */
export function openStageChatSearch(ctx: StageChatViewContext): void {
	if (ctx.search) return;
	const input = new Input();
	input.focused = true;
	ctx.search = {
		input,
		query: "",
		matches: [],
		selectedIndex: -1,
		selectedKey: undefined,
		selectionMode: "query",
		anchorRow: firstVisibleBodyRow(ctx),
		corpusKey: "",
	};
	ctx.requestRender?.();
}

/**
 * Close the find bar. The transcript keeps whatever scroll position the search
 * left it at — closing a search is not an undo.
 */
export function closeStageChatSearch(ctx: StageChatViewContext): void {
	if (!ctx.search) return;
	ctx.search = null;
	ctx.chatHost.invalidate();
	ctx.requestRender?.();
}

/** Replace the query, re-anchoring on the match the reader is looking at. */
export function setStageChatSearchQuery(ctx: StageChatViewContext, query: string): void {
	const search = ctx.search;
	if (!search || query === search.query) return;
	const selected = search.matches[search.selectedIndex];
	search.anchorRow = selected?.segments[0]?.row ?? firstVisibleBodyRow(ctx);
	search.query = query;
	search.selectionMode = "query";
	search.corpusKey = "";
	search.selectedIndex = -1;
	ctx.requestRender?.();
}

/** Step the selection forward (`1`) or backward (`-1`), wrapping at the ends. */
export function navigateStageChatSearch(ctx: StageChatViewContext, direction: 1 | -1): void {
	const search = ctx.search;
	if (!search?.query.trim()) return;
	search.selectionMode = direction < 0 ? "previous" : "next";
	search.corpusKey = "";
	ctx.requestRender?.();
}

/** Feed a keystroke to the query editor, reporting whether it changed the query. */
export function typeIntoStageChatSearch(ctx: StageChatViewContext, data: string): void {
	const search = ctx.search;
	if (!search) return;
	const before = search.input.getValue();
	search.input.handleInput(data);
	const after = search.input.getValue();
	if (after !== before) setStageChatSearchQuery(ctx, after);
	else ctx.requestRender?.();
}

/**
 * Re-match against the current transcript and, when the selection moved, scroll
 * the body so the selected match is on screen.
 *
 * Called once per frame *before* the body is painted, with the row budget that
 * frame will give it. Re-matching is skipped when neither the query nor the
 * corpus shape changed, so a streaming stage does not re-scan its whole
 * transcript on every animation tick.
 */
export function refreshStageChatSearch(ctx: StageChatViewContext, width: number, bodyRows: number): void {
	const search = ctx.search;
	if (!search) return;
	let rowCount = ctx.chatHost.bodyRowCount(width);
	if (rowCount === 0) {
		// The body's component stack is installed by `renderBody`, so a search
		// opened before this chat ever painted has nothing to measure yet. Paint
		// once and re-measure rather than returning a wrong "no matches".
		ctx.chatHost.renderBody(width, Math.max(1, bodyRows));
		rowCount = ctx.chatHost.bodyRowCount(width);
	}
	const corpusKey = `${width}:${rowCount}:${search.query}`;
	if (corpusKey === search.corpusKey) return;
	const hasQuery = search.query.trim().length > 0;
	if (!hasQuery || rowCount <= 0) {
		// An empty query is a settled answer and is cached. A query with nothing
		// to search yet is not: leave the key clear so the next frame retries.
		search.corpusKey = hasQuery ? "" : corpusKey;
		search.matches = [];
		search.selectedIndex = -1;
		search.selectedKey = undefined;
		search.selectionMode = "retain";
		return;
	}
	search.corpusKey = corpusKey;
	const revealSelection = search.selectionMode !== "retain";
	const lines = ctx.chatHost.renderBodyRows(width, 0, rowCount);
	const matches = findSearchMatches(lines, search.query);
	search.selectedIndex = selectMatchIndex(search, matches);
	search.matches = matches;
	search.selectedKey = search.selectedIndex >= 0 ? getSearchMatchKey(matches[search.selectedIndex]!) : undefined;
	search.selectionMode = "retain";
	if (revealSelection) revealSelectedMatch(ctx, search, bodyRows);
}

function selectMatchIndex(search: StageChatSearchState, matches: readonly TranscriptSearchMatch[]): number {
	if (matches.length === 0) return -1;
	const exactIndex = search.selectedKey
		? matches.findIndex((match) => getSearchMatchKey(match) === search.selectedKey)
		: -1;
	switch (search.selectionMode) {
		case "query": {
			const index = matches.findIndex((match) => (match.segments[0]?.row ?? 0) >= search.anchorRow);
			return index < 0 ? 0 : index;
		}
		case "next": {
			const base = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
			return base < 0 ? 0 : (base + 1) % matches.length;
		}
		case "previous": {
			const base = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
			return base < 0 ? matches.length - 1 : (base - 1 + matches.length) % matches.length;
		}
		default:
			return exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
	}
}

/**
 * Scroll only when the selected match is off screen, and then put it a third of
 * the way down rather than at the very top, so the rows around it read as
 * context instead of the match being pinned to an edge.
 *
 * The top body row is not counted as on screen: while the reader is scrolled up
 * the follow indicator takes that row, so a match parked there would be
 * reported as visible and never shown. The cushion is at least one row, which
 * is what keeps that test from re-firing on the row it just revealed.
 */
function revealSelectedMatch(ctx: StageChatViewContext, search: StageChatSearchState, bodyRows: number): void {
	const selected = search.matches[search.selectedIndex];
	const first = selected?.segments[0];
	const last = selected?.segments[selected.segments.length - 1];
	if (!first || !last || bodyRows <= 0) return;
	const top = firstVisibleBodyRow(ctx);
	const bottom = top + bodyRows - 1;
	if (first.row > top && last.row <= bottom) return;
	ctx.chatHost.scrollBodyTo(first.row - Math.max(1, Math.floor(bodyRows / 3)));
}

function firstVisibleBodyRow(ctx: StageChatViewContext): number {
	return Math.max(0, ctx.chatHost.bodyMaxScroll() - ctx.chatHost.bodyScrollFromBottom());
}

/**
 * Repaint the body rows that carry a match.
 *
 * `firstRow` is the absolute row `lines[0]` came from, which is how a match
 * found anywhere in the transcript lands on the right line of the window.
 */
export function highlightStageChatSearchRows(
	ctx: StageChatViewContext,
	lines: readonly string[],
	firstRow: number,
): string[] {
	const search = ctx.search;
	if (!search || search.matches.length === 0) return [...lines];
	const styles = stageChatSearchStyles(ctx);
	const rangesByRow = new Map<number, TranscriptSearchHighlightRange[]>();
	for (let matchIndex = 0; matchIndex < search.matches.length; matchIndex += 1) {
		for (const segment of search.matches[matchIndex]!.segments) {
			const row = segment.row - firstRow;
			if (row < 0 || row >= lines.length) continue;
			const ranges = rangesByRow.get(row) ?? [];
			ranges.push({
				startCol: segment.startCol,
				endCol: segment.endCol,
				current: matchIndex === search.selectedIndex,
			});
			rangesByRow.set(row, ranges);
		}
	}
	const result = [...lines];
	for (const [row, ranges] of rangesByRow) {
		result[row] = highlightSearchMatchRow(result[row] ?? "", ranges, styles);
	}
	return result;
}

/**
 * Match styling, read from the host theme on every frame so `/theme` repaints
 * an open search rather than leaving it on the palette it opened with.
 */
export function stageChatSearchStyles(ctx: StageChatViewContext): TranscriptSearchHighlightStyles {
	const colors = searchMatchColors(ctx.piTheme, ctx.theme);
	return {
		match: (text) => paint(text, colors.text, { bg: colors.bg }),
		currentMatch: (text) => paint(text, colors.text, { bg: colors.bg, bold: true }),
	};
}

/**
 * The find bar: a labelled title row and the query line, exactly
 * `STAGE_CHAT_SEARCH_ROWS` tall so the frame planner can reserve it before the
 * body budget is known.
 */
export function renderStageChatSearchBar(ctx: StageChatViewContext, width: number): string[] {
	const search = ctx.search;
	if (!search) return [];
	const safeWidth = Math.max(1, width);
	const label = " Find in stage chat";
	const status = !search.query.trim()
		? " "
		: search.matches.length === 0
			? "No matches "
			: `${search.selectedIndex + 1}/${search.matches.length} `;
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(label) - visibleWidth(status)));
	const title = truncateToWidth(`${label}${gap}${status}`, safeWidth, "");
	const titlePad = " ".repeat(Math.max(0, safeWidth - visibleWidth(title)));
	const queryRow = search.input.render(safeWidth)[0] ?? blankLine(safeWidth);
	return [paint(`${title}${titlePad}`, ctx.theme.text, { bg: ctx.theme.backgroundPanel, bold: true }), queryRow];
}
