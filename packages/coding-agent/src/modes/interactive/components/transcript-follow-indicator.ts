import { type Component, hyperlink, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { jumpToLatestLabel } from "./jump-to-latest.ts";

export const TRANSCRIPT_JUMP_TO_END_URL = "atomic-ui://transcript/jump-to-end";
const FULL_RESET = "\x1b[0m";

export interface TranscriptFollowIndicatorOptions {
	isFollowing: () => boolean;
	keyLabel: () => string;
	newCount?: () => number;
}

/** Shows the clickable affordance for a transcript that is detached from its live end. */
export class TranscriptFollowIndicator implements Component {
	private readonly options: TranscriptFollowIndicatorOptions;

	constructor(options: TranscriptFollowIndicatorOptions) {
		this.options = options;
	}
	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.isFollowing()) return [];

		const viewportWidth = Math.max(0, Math.floor(width));
		if (viewportWidth === 0) return [""];

		const keyLabel = this.options.keyLabel();
		const label = jumpToLatestLabel(this.options.newCount?.() ?? 0, keyLabel);

		// The highlight is the box: one padding column on each side, dropped when the
		// viewport cannot afford both columns and a visible character.
		const sidePadding = viewportWidth >= 3 ? 1 : 0;
		const truncatedLabel = truncateToWidth(label, viewportWidth - sidePadding * 2);
		const labelWidth = visibleWidth(truncatedLabel);
		if (labelWidth === 0) return [""];

		const pad = " ".repeat(sidePadding);
		const highlightWidth = labelWidth + sidePadding * 2;
		const leftPadding = " ".repeat(Math.floor((viewportWidth - highlightWidth) / 2));
		// `truncateToWidth` marks its ellipsis with a full SGR reset, which would punch a
		// hole in the highlight; restore both colors after every reset it emits.
		const restyled = truncatedLabel.replaceAll(
			FULL_RESET,
			`${FULL_RESET}${theme.getBgAnsi("selectedBg")}${theme.getFgAnsi("text")}`,
		);
		const highlighted = theme.bg("selectedBg", theme.fg("text", `${pad}${restyled}${pad}`));

		return [`${leftPadding}${hyperlink(highlighted, TRANSCRIPT_JUMP_TO_END_URL)}`];
	}
}
