import { type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../../modes/interactive/theme/theme.js";
import { fieldTone, styleFieldTone } from "../../../state/selectors/field-tone.ts";
import type { QuestionData } from "../../../tool/types.js";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.ts";
import type { PreviewLayoutMode } from "./preview-layout-decider.ts";

/**
 * Affordance text shown below the bordered preview when focused on a preview-bearing option.
 * Re-exported by `preview-pane.ts` for the existing test surface.
 */
export const NOTES_AFFORDANCE_TEXT = "Notes: n add notes";
const NOTES_LABEL = "Notes: ";

export interface PreviewBlockRendererConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
}

/**
 * Renders the bordered markdown preview block for a single question (one block per render call,
 * for the option at `optionIndex`). Owns a per-question `MarkdownContentCache`.
 *
 * NOT a `Component` — pure render-and-measure helper consumed by `PreviewPane`. The layout mode
 * is threaded as an explicit param (never re-derived from column width post-split).
 *
 * The affordance row is always emitted (visually empty when gated) so the preview block's row
 * count is height-stable across affordance-state transitions.
 */
export class PreviewBlockRenderer {
	private readonly theme: Theme;
	private readonly cache: MarkdownContentCache;

	constructor(config: PreviewBlockRendererConfig) {
		this.theme = config.theme;
		this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
	}

	hasAnyPreview(): boolean {
		return this.cache.hasAnyPreview();
	}

	has(optionIndex: number): boolean {
		return this.cache.has(optionIndex);
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	/**
	 * Height contribution of the preview block: `BORDER_VERTICAL_OVERHEAD + contentRows +
	 * NOTES_AFFORDANCE_OVERHEAD`. Always returns the same value as `renderBlock(...).length`
	 * — the affordance overhead is constant, not gated by `focused`/`notesVisible`.
	 */
	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode): number {
		const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
		const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
		const innerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
		const rawRows = this.cache.bodyFor(optionIndex, innerWidth).length;
		const contentRows = Math.min(rawRows, contentBudget);
		return BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD;
	}

	/**
	 * Render the full preview block at `width`: bordered box + blank separator + affordance row.
	 * `focused` and `notesVisible` together gate the affordance text (visible only when the
	 * focused option carries a preview AND notes mode is inactive). The affordance row is ALWAYS
	 * emitted (as an empty string when gated) so the row count is invariant. It shows the saved
	 * `notes` in the `answered` tone, or the add-notes prompt in the `placeholder` tone.
	 */
	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		focused: boolean,
		notesVisible: boolean,
		notes: string,
	): string[] {
		const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
		const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
		const maxInnerWidth = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);

		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const truncated = raw.length > contentBudget;
		const hidden = truncated ? raw.length - contentBudget : 0;
		const contentLines = truncated ? raw.slice(0, contentBudget) : raw;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);

		const showAffordance = focused && !notesVisible && this.cache.has(optionIndex);
		return [...boxedLines, "", showAffordance ? this.renderNotesAffordance(width, notes) : ""];
	}

	private renderNotesAffordance(width: number, notes: string): string {
		const tone = fieldTone(false, notes);
		if (tone === "placeholder") return styleFieldTone(this.theme, tone, NOTES_AFFORDANCE_TEXT);
		const line = `${this.theme.fg("muted", NOTES_LABEL)}${styleFieldTone(this.theme, tone, notes)}`;
		return truncateToWidth(line, width, "…");
	}
}
