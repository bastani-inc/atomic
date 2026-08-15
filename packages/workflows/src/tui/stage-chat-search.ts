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
	/**
	 * Row the selection is re-derived from when the query changes, or
	 * `undefined` for "wherever the reader will be when the next frame is
	 * matched". See `resolveAnchorRow`.
	 */
	anchorRow: number | undefined;
}

/**
 * Open the find bar.
 *
 * Opening also takes the streaming tail window off the body. A stage that is
 * mid-turn renders only the last 240 lines of the live assistant entry while
 * the reader follows the bottom, and those are the rows this search would
 * otherwise measure: the first half of a long answer would report `No matches`
 * for text still on the reader's screen a page earlier.
 *
 * Which is also why no anchor row is recorded here. Row numbers are positions
 * in a corpus, and this call has just changed the corpus: `bodyMaxScroll` still
 * describes the truncated stack the last frame painted, so a reader parked on
 * the newest row of a long live stream would be anchored a few hundred rows
 * above where they are reading and the first match chosen would be one they
 * had scrolled past minutes ago. The anchor is resolved instead on the frame
 * that actually matches, against the rows that frame measured.
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
		anchorRow: undefined,
	};
	ctx.chatHost.setStreamingTailWindowEnabled(false);
	ctx.requestRender?.();
}

/**
 * Close the find bar and give the streaming tail window back. The transcript
 * keeps whatever scroll position the search left it at — closing a search is
 * not an undo.
 */
export function closeStageChatSearch(ctx: StageChatViewContext): void {
	if (!ctx.search) return;
	ctx.search = null;
	ctx.chatHost.setStreamingTailWindowEnabled(true);
	ctx.chatHost.invalidate();
	ctx.requestRender?.();
}

/**
 * Replace the query, re-anchoring on the match the reader is looking at.
 *
 * With no match selected there is nothing to re-anchor on, and the reader's own
 * position is deliberately *not* read here either: a query typed before the
 * first frame of an open search would be anchored in the pre-search corpus.
 * Clearing the anchor asks the next refresh for it.
 */
export function setStageChatSearchQuery(ctx: StageChatViewContext, query: string): void {
	const search = ctx.search;
	if (!search || query === search.query) return;
	search.anchorRow = search.matches[search.selectedIndex]?.segments[0]?.row;
	search.query = query;
	search.selectionMode = "query";
	search.selectedIndex = -1;
	ctx.requestRender?.();
}

/** Step the selection forward (`1`) or backward (`-1`), wrapping at the ends. */
export function navigateStageChatSearch(ctx: StageChatViewContext, direction: 1 | -1): void {
	const search = ctx.search;
	if (!search?.query.trim()) return;
	search.selectionMode = direction < 0 ? "previous" : "next";
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
 * Where this frame paints the transcript, which is what the reveal arithmetic
 * needs and the frame planner already knows.
 *
 * `transcriptRows` is the row budget the transcript itself gets, which is the
 * whole body on a live chat and the body minus its callout on a paused or
 * archived one. `indicatorSharesTranscriptRows` says whether the follow
 * indicator, when it appears, takes one of those rows (the live body) or has
 * its own reserved outside them (paused and archived bodies).
 */
export interface StageChatSearchBodyLayout {
	readonly transcriptRows: number;
	readonly indicatorSharesTranscriptRows: boolean;
}

/**
 * Re-match against the current transcript and, when the selection moved, scroll
 * the body so the selected match is on screen.
 *
 * Called once per frame *before* the body is painted, with the rows that frame
 * will give the transcript.
 *
 * The match run is not cached. A stage that is streaming rewrites the rows it
 * already has — a token appended to the last line changes no row count and no
 * width — so every key cheaper than the rendered text itself answers a live
 * search with the transcript as it was, which is the one thing an open search
 * may not do. The corpus is measured every frame regardless (`bodyRowCount`
 * renders the whole stack to count it), so re-reading the rows that
 * measurement just produced is the cheap half of the work, and the transcript's
 * own per-entry block cache keeps an unchanged entry from being re-rendered.
 */
export function refreshStageChatSearch(
	ctx: StageChatViewContext,
	width: number,
	layout: StageChatSearchBodyLayout,
): void {
	const search = ctx.search;
	if (!search) return;
	const revealSelection = search.selectionMode !== "retain";
	if (!search.query.trim()) {
		search.matches = [];
		search.selectedIndex = -1;
		search.selectedKey = undefined;
		search.selectionMode = "retain";
		return;
	}
	let rowCount = ctx.chatHost.bodyRowCount(width);
	if (rowCount === 0) {
		// The body's component stack is installed by `renderBody`, so a search
		// opened before this chat ever painted has nothing to measure yet. Paint
		// once and re-measure rather than returning a wrong "no matches".
		ctx.chatHost.renderBody(width, Math.max(1, layout.transcriptRows));
		rowCount = ctx.chatHost.bodyRowCount(width);
	}
	if (rowCount <= 0) {
		// Nothing to search *yet*. The pending selection mode is deliberately
		// kept, so the frame that finally has rows still anchors and reveals.
		search.matches = [];
		search.selectedIndex = -1;
		search.selectedKey = undefined;
		return;
	}
	const lines = ctx.chatHost.renderBodyRows(width, 0, rowCount);
	const matches = findSearchMatches(lines, search.query);
	// A query typed but not yet anchored is anchored *here*, against the rows
	// this frame measured. Anywhere earlier is a different corpus: opening the
	// search dropped the streaming tail window, and a live stage grows between
	// renders, so a row number recorded before this point names a row the
	// reader is not on.
	if (search.selectionMode === "query" && search.anchorRow === undefined) {
		search.anchorRow = predictedFirstVisibleBodyRow(ctx, rowCount, Math.max(1, Math.floor(layout.transcriptRows)));
	}
	search.selectedIndex = selectMatchIndex(search, matches);
	search.matches = matches;
	search.selectedKey = search.selectedIndex >= 0 ? getSearchMatchKey(matches[search.selectedIndex]!) : undefined;
	search.selectionMode = "retain";
	if (revealSelection) revealSelectedMatch(ctx, search, rowCount, layout);
}

function selectMatchIndex(search: StageChatSearchState, matches: readonly TranscriptSearchMatch[]): number {
	if (matches.length === 0) return -1;
	const exactIndex = search.selectedKey
		? matches.findIndex((match) => getSearchMatchKey(match) === search.selectedKey)
		: -1;
	switch (search.selectionMode) {
		case "query": {
			const anchorRow = search.anchorRow ?? 0;
			const index = matches.findIndex((match) => (match.segments[0]?.row ?? 0) >= anchorRow);
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
 * "On screen" is measured against the rows *this* frame will paint, not the
 * last one. A live stage grows its transcript between renders, and the window
 * moves with it: a reader following the bottom is about to be shown the newest
 * rows, so a match judged against the previous frame's window is judged against
 * rows that have already scrolled away. That is how a match could be counted
 * `1/1` and never revealed.
 *
 * The window is also not the whole row budget. Where the follow indicator
 * shares the transcript's rows it takes the top one, except on a body already
 * parked at row zero, where `StageChatView` gives up the bottom row instead so
 * the first transcript row stays reachable. This follows that rule exactly; a
 * looser one reports a clipped match as revealed and the search never scrolls.
 */
function revealSelectedMatch(
	ctx: StageChatViewContext,
	search: StageChatSearchState,
	rowCount: number,
	layout: StageChatSearchBodyLayout,
): void {
	const selected = search.matches[search.selectedIndex];
	const first = selected?.segments[0];
	const last = selected?.segments[selected.segments.length - 1];
	const rows = Math.max(0, Math.floor(layout.transcriptRows));
	if (!first || !last || rows <= 0) return;
	const top = predictedFirstVisibleBodyRow(ctx, rowCount, rows);
	const scrolledUp = ctx.chatHost.bodyScrollFromBottom() > 0;
	const indicatorRow = layout.indicatorSharesTranscriptRows && scrolledUp && rows > 1 ? 1 : 0;
	const firstVisible = top === 0 ? 0 : top + indicatorRow;
	const lastVisible = top + rows - 1 - (top === 0 ? indicatorRow : 0);
	if (first.row >= firstVisible && last.row <= lastVisible) return;
	// At least one row of cushion, so the revealed match never lands on the row
	// the indicator takes.
	ctx.chatHost.scrollBodyTo(first.row - Math.max(1, Math.floor(rows / 3)));
}

/**
 * The first row the body will show once this frame renders.
 *
 * A reader following the bottom lands on the last window of the transcript as
 * it is *now*, rows and all that arrived since the last paint. A reader
 * scrolled up keeps the row they are reading, which is what the viewport's own
 * anchor does for them.
 */
function predictedFirstVisibleBodyRow(ctx: StageChatViewContext, rowCount: number, transcriptRows: number): number {
	const maxScroll = Math.max(0, rowCount - transcriptRows);
	if (ctx.chatHost.bodyScrollFromBottom() === 0) return maxScroll;
	return Math.max(0, Math.min(maxScroll, firstVisibleBodyRow(ctx)));
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
 *
 * Colors *and* attributes match the fullscreen transcript search: an ordinary
 * match is underlined, the selected one is inverse and bold
 * (`interactive-tui.ts` createFullscreenTui). Same two theme tokens, same two
 * attributes — a reader who searches a stage chat and then the transcript
 * behind it sees one feature rather than two that resemble each other.
 */
export function stageChatSearchStyles(ctx: StageChatViewContext): TranscriptSearchHighlightStyles {
	const colors = searchMatchColors(ctx.piTheme, ctx.theme);
	return {
		match: (text) => paint(text, colors.text, { bg: colors.bg, underline: true }),
		currentMatch: (text) => paint(text, colors.text, { bg: colors.bg, bold: true, inverse: true }),
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
