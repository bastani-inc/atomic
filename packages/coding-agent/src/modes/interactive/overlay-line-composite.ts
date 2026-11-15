import { compositeTuiLine, visibleWidth } from "@bastani/atomic-tui";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

function containsImageSequence(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}

/**
 * Composite an overlay row onto a base row. A row that spans the whole
 * terminal hides the base entirely, so it skips the grapheme scan of the base
 * line that `compositeTuiLine` performs for partial overlays.
 */
export function compositeOverlayLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const coversRow = startCol === 0 && overlayWidth === totalWidth;
	if (!coversRow || containsImageSequence(baseLine) || containsImageSequence(overlayLine)) {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}
	const overlayVisibleWidth = visibleWidth(overlayLine);
	if (overlayVisibleWidth > overlayWidth) {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}
	return `${SEGMENT_RESET}${overlayLine}${" ".repeat(overlayWidth - overlayVisibleWidth)}${SEGMENT_RESET}`;
}
