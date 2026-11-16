import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { INPUT_LABEL_MIN_COLUMNS } from "./input-label.ts";

export interface ComposerRuleLabel {
	readonly plain: string;
	readonly styled: string;
}

export interface ComposerRuleOptions {
	readonly label?: ComposerRuleLabel | string;
	readonly color: (text: string) => string;
	readonly heavy?: boolean;
}

export function composerRuleGlyph(heavy: boolean | undefined): string {
	return heavy ? "━" : "─";
}

export function renderComposerRule(width: number, options: ComposerRuleOptions): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const glyph = composerRuleGlyph(options.heavy);
	const label = typeof options.label === "string" ? { plain: options.label, styled: options.label } : options.label;
	const plain = label?.plain.trim() ?? "";
	if (!label || plain.length === 0 || columns < INPUT_LABEL_MIN_COLUMNS) return options.color(glyph.repeat(columns));
	const room = columns - 5;
	const fits = visibleWidth(label.plain) <= room;
	const shown = fits ? label.styled : truncateToWidth(label.plain, room, "…");
	const shownWidth = fits ? visibleWidth(label.plain) : visibleWidth(shown);
	const before = columns - shownWidth - 3;
	return `${options.color(`${glyph.repeat(before)} `)}${shown}${options.color(` ${glyph}`)}`;
}
