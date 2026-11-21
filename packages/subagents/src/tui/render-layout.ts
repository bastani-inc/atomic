import type { ExtensionContext } from "@bastani/atomic";
import { visibleWidth } from "@bastani/atomic-tui";

export type Theme = ExtensionContext["ui"]["theme"];

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** SGR styling, or an APC marker such as a clickable key hint's; neither takes a column. */
const ZERO_WIDTH_CODE = /^(?:\x1b\[[0-9;]*m|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(ZERO_WIDTH_CODE);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else if (code.startsWith("\x1b[")) {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(ZERO_WIDTH_CODE)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return `${result + activeStyles.join("")}…`;
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return `${result + activeStyles.join("")}…`;
}
