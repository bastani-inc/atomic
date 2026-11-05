import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../../modes/interactive/theme/theme.js";
import type { QuestionData } from "../../../tool/types.js";
import { stripFenceMarkers } from "./preview-box-renderer.ts";

/** CC parity in side-by-side layout. */
export const MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE = 20;
/** Preserves narrow-terminal protection in stacked layout. */
export const MAX_PREVIEW_HEIGHT_STACKED = 15;
export const NO_PREVIEW_TEXT = "No preview available";
/** 1 blank separator + 1 affordance text row reserved when `hasAnyPreview` (height stability of the affordance row's offset relative to the box). */
export const NOTES_AFFORDANCE_OVERHEAD = 2;

/**
 * Inner widths whose preview bodies stay cached. Two covers a resize back and forth; a few more cover a short drag
 * without letting a long one grow the cache without bound. The oldest width is dropped first.
 */
export const MAX_CACHED_PREVIEW_WIDTHS = 4;

/**
 * Per-question cache for rendered markdown previews, keyed by (option, inner width). Preview text never changes
 * for a question, so the option index stands for the content. Each body is wrapped by pi-tui's `Markdown` and
 * stripped of fence markers once per width; measuring and painting at that width reuse the same lines.
 *
 * One Markdown per option, lazy on first request, never re-constructed.
 */
export class MarkdownContentCache {
	private readonly previewTexts: Map<number, string>;
	private readonly markdownCache: Map<number, Markdown>;
	private readonly bodiesByWidth = new Map<number, Map<number, string[]>>();
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

	/** Body lines for an option at an inner width, rendered once per (option, width). */
	bodyFor(optionIndex: number, innerWidth: number): string[] {
		const text = this.previewTexts.get(optionIndex);
		if (!text) {
			const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
			const pad = Math.max(0, innerWidth - visibleWidth(placeholder));
			return [placeholder + " ".repeat(pad)];
		}
		const bodies = this.bodiesAt(innerWidth);
		const cached = bodies.get(optionIndex);
		if (cached) return cached;
		let md = this.markdownCache.get(optionIndex);
		if (!md) {
			md = new Markdown(text, 0, 0, this.markdownTheme);
			this.markdownCache.set(optionIndex, md);
		}
		const body = stripFenceMarkers(md.render(innerWidth));
		bodies.set(optionIndex, body);
		return body;
	}

	invalidate(): void {
		for (const md of this.markdownCache.values()) md.invalidate();
		this.bodiesByWidth.clear();
	}

	private bodiesAt(innerWidth: number): Map<number, string[]> {
		const existing = this.bodiesByWidth.get(innerWidth);
		if (existing) return existing;
		const bodies = new Map<number, string[]>();
		this.bodiesByWidth.set(innerWidth, bodies);
		if (this.bodiesByWidth.size > MAX_CACHED_PREVIEW_WIDTHS) {
			const oldest = this.bodiesByWidth.keys().next().value;
			if (oldest !== undefined) this.bodiesByWidth.delete(oldest);
		}
		return bodies;
	}
}
