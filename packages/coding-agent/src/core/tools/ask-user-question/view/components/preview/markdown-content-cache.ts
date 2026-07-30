import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../../modes/interactive/theme/theme.ts";
import type { QuestionData } from "../../../tool/types.ts";
import { stripFenceMarkers } from "./preview-box-renderer.ts";

/** CC parity in side-by-side layout. */
export const MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE = 20;
/** Preserves narrow-terminal protection in stacked layout. */
export const MAX_PREVIEW_HEIGHT_STACKED = 15;
export const NO_PREVIEW_TEXT = "No preview available";
/** 1 blank separator + 1 affordance text row reserved when `hasAnyPreview` (height stability of the affordance row's offset relative to the box). */
export const NOTES_AFFORDANCE_OVERHEAD = 2;

/**
 * Per-question cache for rendered markdown previews. Width-keyed: switching the
 * inner width invalidates every cached `Markdown`'s render output (pi-tui's
 * `Markdown.render(width)` re-wraps when width changes).
 *
 * Replaces the inline `previewTexts`, `markdownCache`, `cachedWidth` triple from
 * the previous monolithic `preview-pane.ts`. One Markdown per option, lazy on
 * first request, never re-constructed — count semantics frozen by tests.
 */
export class MarkdownContentCache {
	private readonly previewTexts: Map<number, string>;
	private readonly markdownCache: Map<number, Markdown>;
	private cachedWidth: number | undefined;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;

	constructor(question: QuestionData, theme: Theme, markdownTheme: MarkdownTheme) {
		this.theme = theme;
		this.markdownTheme = markdownTheme;
		this.previewTexts = new Map();
		for (let i = 0; i < question.options.length; i++) {
			const raw = question.options[i]?.preview;
			if (raw && raw.length > 0) this.previewTexts.set(i, raw);
		}
		this.markdownCache = new Map();
	}

	hasAnyPreview(): boolean {
		return this.previewTexts.size > 0;
	}

	has(optionIndex: number): boolean {
		return this.previewTexts.has(optionIndex);
	}

	/**
	 * Compute the body lines for a given option at a given inner width. Width changes
	 * invalidate the per-Markdown render cache.
	 */
	bodyFor(optionIndex: number, innerWidth: number): string[] {
		if (this.cachedWidth !== innerWidth) {
			for (const md of this.markdownCache.values()) md.invalidate();
			this.cachedWidth = innerWidth;
		}
		const text = this.previewTexts.get(optionIndex);
		if (!text) {
			const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
			const pad = Math.max(0, innerWidth - visibleWidth(placeholder));
			return [placeholder + " ".repeat(pad)];
		}
		let md = this.markdownCache.get(optionIndex);
		if (!md) {
			md = new Markdown(text, 0, 0, this.markdownTheme);
			this.markdownCache.set(optionIndex, md);
		}
		return stripFenceMarkers(md.render(innerWidth));
	}

	invalidate(): void {
		for (const md of this.markdownCache.values()) md.invalidate();
		this.cachedWidth = undefined;
	}
}
