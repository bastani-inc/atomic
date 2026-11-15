import { visibleWidth } from "@bastani/atomic-tui";
import type { QuestionData } from "../../../tool/types.js";
import type { WrappingSelectItem } from "../wrapping-select.ts";
import { BORDER_HORIZONTAL_OVERHEAD, BORDER_INNER_PADDING_HORIZONTAL } from "./preview-box-renderer.ts";

/** Min terminal/pane width for the side-by-side layout to engage. */
export const PREVIEW_MIN_WIDTH = 100;
/** Visual gap between options column and preview column in side-by-side. */
export const PREVIEW_COLUMN_GAP = 2;
/** 1 col padding inside the preview column (between gap and `│`). */
export const PREVIEW_PADDING_LEFT = 1;
/** Empty rows between options and preview blocks in stacked (narrow) layout. */
export const STACKED_GAP_ROWS = 1;

/** Floor for the adaptive left column width — prevents collapse on short labels. */
export const MIN_LEFT = 30;
/** Ceiling ratio: left column never exceeds this fraction of pane width. */
export const MAX_LEFT_RATIO = 0.5;
/** Floor for the preview column width — prevents right-side collapse on narrow terminals. */
export const MIN_PREVIEW_WIDTH = 45;
/** visibleWidth(" ✔") = 2 (space + ✔ codepoint). Reserved on the longest-label measurement
 *  so a confirmed row never gets truncated when MIN_LEFT clamps the column. */
export const CONFIRMED_OVERHEAD = 2;

export type PreviewLayoutMode = "side-by-side" | "stacked";

/**
 * Decide layout mode from terminal + pane widths. Pure of inputs.
 *
 * The terminal-width gate is the AND check from the previous `preview-pane.ts` —
 * lifted here so the decision is computed ONCE per render and threaded explicitly
 * through `previewBlockHeight`. Removes the bug class where `previewBlockHeight`
 * re-derived `sideBySide` from a column width (already < pane width post-split),
 * capping height too short.
 */
export function decideLayout(terminalWidth: number, paneWidth: number): PreviewLayoutMode {
	return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH ? "side-by-side" : "stacked";
}

/**
 * Compute the adaptive left column width from option labels.
 * Pure function — deterministic for a given (items, totalForNumbering, paneWidth).
 *
 * Pipeline:
 *   1. Measure: longest visible label width + prefix overhead + confirmed-mark overhead
 *   2. Clamp: floor MIN_LEFT, ceiling paneWidth * MAX_LEFT_RATIO
 *   3. Safety net: never exceed available = paneWidth - GAP - MIN_PREVIEW_WIDTH
 */
export function adaptiveLeftWidth(
	items: readonly WrappingSelectItem[],
	totalForNumbering: number,
	paneWidth: number,
): number {
	const prefixW = String(Math.max(1, totalForNumbering)).length + 4; // digits + "❯ " + ". "
	const confirmedOverhead = CONFIRMED_OVERHEAD; // visibleWidth(" ✔") = 2 (space + ✔ codepoint)
	let maxLabel = 0;
	for (const item of items) {
		const w = visibleWidth(item.label);
		if (w > maxLabel) maxLabel = w;
	}
	const desired = maxLabel + prefixW + confirmedOverhead;
	const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
	const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.max(MIN_LEFT, Math.min(ratioCapped, Math.max(1, available)));
}

/**
 * Cross-tab maximum left-column width. Aggregates `adaptiveLeftWidth` over every tab
 * and returns the widest result, so the options column stays stable on tab switch.
 *
 * Pure function — `tabs.length` MUST equal `itemsByTab.length`. Multi-select tabs
 * use `items.length` for numbering; single-select tabs add 1 for the chat row slot.
 * Floor is `MIN_LEFT` so an all-empty input still produces a usable column.
 */
export function crossTabMaxLeftWidth(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	paneWidth: number,
): number {
	let max = MIN_LEFT;
	for (let i = 0; i < tabs.length; i++) {
		const items = itemsByTab[i] ?? [];
		const totalForNumbering = tabs[i]?.multiSelect ? items.length : items.length + 1;
		const tabWidth = adaptiveLeftWidth(items, totalForNumbering, paneWidth);
		if (tabWidth > max) max = tabWidth;
	}
	return max;
}

/**
 * Source-line probe: measures the widest source line across all options' previews.
 * Returns 0 when no option carries a preview.
 *
 * V1 heuristic — works well for tree/table/heading/list content where source-line
 * width ≈ rendered width. Paragraphs overstate (source width "wants" the full pane);
 * the worst case is "donation does nothing useful" — fallback to the label-driven path.
 * Upgrade path: replace with a render-width probe that invokes Markdown at a probe width.
 *
 * Pure function — O(total chars) per question; no Markdown invocation, no cache interaction.
 */
export function previewSourceWidth(question: QuestionData): number {
	let max = 0;
	for (const option of question.options) {
		const text = option.preview;
		if (!text) continue;
		for (const line of text.split("\n")) {
			const w = visibleWidth(line);
			if (w > max) max = w;
		}
	}
	return max;
}

/**
 * Cross-tab/cross-option preview budget. Iterates all questions, computes each question's
 * preview appetite via `previewSourceWidth`, adds box + padding overhead (5 cols), and
 * returns the widest result. Floor is `MIN_PREVIEW_WIDTH` so a previewless question still
 * reserves a usable column. Ceiling ensures the left column retains its `MIN_LEFT` floor.
 *
 * Pure function — same cross-tab max pattern as `crossTabMaxLeftWidth`.
 */
export function crossTabPreviewBudget(questions: readonly QuestionData[], paneWidth: number): number {
	let max = MIN_PREVIEW_WIDTH;
	for (const question of questions) {
		const rawWidth = previewSourceWidth(question);
		const capped = Math.min(rawWidth, paneWidth - PREVIEW_COLUMN_GAP - MIN_LEFT);
		const budget = capped + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL + PREVIEW_PADDING_LEFT;
		if (budget > max) max = budget;
	}
	return max;
}

/**
 * Cross-tab left-column width with slack donation. Combines the label-driven width
 * (from `crossTabMaxLeftWidth`) with the slack donated by narrow previews.
 *
 * Pipeline:
 *   1. `labelDriven` = `crossTabMaxLeftWidth(tabs, itemsByTab, paneWidth)`
 *   2. `previewBudget` = `crossTabPreviewBudget(questions, paneWidth)`
 *   3. `slackDonation` = `paneWidth − GAP − previewBudget`
 *   4. Return `min(max(labelDriven, slackDonation), ceiling)` where `ceiling = paneWidth − GAP − MIN_PREVIEW_WIDTH`
 *
 * Invariants:
 *   - Floor: result ≥ MIN_LEFT (labelDriven ≥ MIN_LEFT)
 *   - Preview floor: right column ≥ MIN_PREVIEW_WIDTH (ceiling enforces this)
 *   - Cross-tab stability: both reductions are tab-independent
 *   - Determinism: pure of (questions, itemsByTab, paneWidth)
 *
 * `crossTabMaxLeftWidth` is NOT replaced — it continues to exist as the primitive.
 * `MAX_LEFT_RATIO` caps the label-driven path inside `adaptiveLeftWidth`; donation
 * operates above the cap when preview slack is available.
 */
export function crossTabLeftWidthWithDonation(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	questions: readonly QuestionData[],
	paneWidth: number,
): number {
	const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, paneWidth);
	// Compact-content guard: labels at MIN_LEFT fit below the floor, so widening
	// the column would only inject dead space between the option list and the
	// preview box. Skip donation and preserve the compact intent.
	if (labelDriven <= MIN_LEFT) return labelDriven;
	const previewBudget = crossTabPreviewBudget(questions, paneWidth);
	const slackDonation = paneWidth - PREVIEW_COLUMN_GAP - previewBudget;
	const ceiling = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.min(Math.max(labelDriven, slackDonation), Math.max(1, ceiling));
}

/**
 * Width allocation for side-by-side mode.
 * `adaptiveLeft` is the pre-computed left column width (from `adaptiveLeftWidth`,
 * cross-tab aggregated). The Math.max(1, ...) calls keep both columns >= 1 col on
 * extreme inputs.
 */
export function columnWidths(
	paneWidth: number,
	adaptiveLeft: number,
): { leftWidth: number; rightWidth: number; gap: number } {
	const gap = PREVIEW_COLUMN_GAP;
	const leftWidth = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
	const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
	return { leftWidth, rightWidth, gap };
}

/**
 * Returns the widths actually passed to `options.render` and `previewLines` inside
 * `render()`. Stacked uses the full pane width for both; side-by-side splits via
 * `columnWidths`, with the preview column offset by `PREVIEW_PADDING_LEFT`.
 */
export function bodyWidths(
	paneWidth: number,
	mode: PreviewLayoutMode,
	adaptiveLeft: number,
): { optionsWidth: number; previewWidth: number } {
	if (mode === "stacked") return { optionsWidth: paneWidth, previewWidth: paneWidth };
	const { leftWidth, rightWidth } = columnWidths(paneWidth, adaptiveLeft);
	return { optionsWidth: leftWidth, previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT) };
}
