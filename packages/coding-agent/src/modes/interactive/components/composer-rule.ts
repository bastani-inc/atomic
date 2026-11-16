import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { INPUT_LABEL_MIN_COLUMNS } from "./input-label.ts";

/** A rule's label: its plain text, for measuring, and its styled text. A plain string is used as both. */
export interface ComposerRuleLabel {
	readonly plain: string;
	readonly styled: string;
}

export interface ComposerRuleOptions {
	/** Text right-aligned inside the rule, followed by exactly one rule glyph. */
	readonly label?: ComposerRuleLabel | string;
	/** Colours the rule glyphs: the composer's own border colour for the main chat, the accent when attached. */
	readonly color: (text: string) => string;
	/** Draws `━` instead of `─`. */
	readonly heavy?: boolean;
}

/** The glyph a composer rule is drawn with. */
export function composerRuleGlyph(heavy: boolean | undefined): string {
	return heavy ? "━" : "─";
}

/**
 * One full-width composer rule. With a label, the label sits right-aligned with a space on each side and exactly
 * one rule glyph after it, as `─── title ─`; a label too long for the rule is shortened with `…`, and a rule narrower
 * than {@link INPUT_LABEL_MIN_COLUMNS} carries no label at all, so a narrow terminal keeps a plain rule.
 */
export function renderComposerRule(width: number, options: ComposerRuleOptions): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const glyph = composerRuleGlyph(options.heavy);
	const label = typeof options.label === "string" ? { plain: options.label, styled: options.label } : options.label;
	const plain = label?.plain.trim() ?? "";
	if (!label || plain.length === 0 || columns < INPUT_LABEL_MIN_COLUMNS) return options.color(glyph.repeat(columns));
	// Two glyphs at least before the label, a space on each side, one glyph after it.
	const room = columns - 5;
	const fits = visibleWidth(label.plain) <= room;
	const shown = fits ? label.styled : truncateToWidth(label.plain, room, "…");
	const shownWidth = fits ? visibleWidth(label.plain) : visibleWidth(shown);
	const before = columns - shownWidth - 3;
	return `${options.color(`${glyph.repeat(before)} `)}${shown}${options.color(` ${glyph}`)}`;
}
