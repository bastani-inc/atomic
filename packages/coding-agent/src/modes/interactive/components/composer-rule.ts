import { replaceControlCharacters, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
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

export function sanitizeRuleLabel(value: string): string {
	return replaceControlCharacters(value).replace(/\s+/g, " ").trim();
}

function normalizeComposerRuleLabel(label: ComposerRuleLabel | string | undefined): ComposerRuleLabel | undefined {
	if (label === undefined) return undefined;
	if (typeof label === "string") {
		const clean = sanitizeRuleLabel(label);
		return { plain: clean, styled: clean };
	}
	const cleanPlain = sanitizeRuleLabel(label.plain);
	const styled = label.plain === cleanPlain ? label.styled : cleanPlain;
	return { plain: cleanPlain, styled };
}

export function composerRuleGlyph(heavy: boolean | undefined): string {
	return heavy ? "━" : "─";
}

export function renderComposerRule(width: number, options: ComposerRuleOptions): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const glyph = composerRuleGlyph(options.heavy);
	const label = normalizeComposerRuleLabel(options.label);
	const plain = label?.plain ?? "";
	if (!label || plain.length === 0 || columns < INPUT_LABEL_MIN_COLUMNS) return options.color(glyph.repeat(columns));
	const room = columns - 5;
	const fits = visibleWidth(plain) <= room;
	const shown = fits ? label.styled : truncateToWidth(label.styled, room, "…");
	const shownWidth = fits ? visibleWidth(plain) : visibleWidth(shown);
	const before = columns - shownWidth - 3;
	return `${options.color(`${glyph.repeat(before)} `)}${shown}${options.color(` ${glyph}`)}`;
}
