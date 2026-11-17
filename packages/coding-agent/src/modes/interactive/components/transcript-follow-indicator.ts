import { type Component, hyperlink, visibleWidth } from "@bastani/atomic-tui";
import { jumpToLatestPill } from "./jump-to-latest.ts";

export const TRANSCRIPT_JUMP_TO_END_URL = "atomic-ui://transcript/jump-to-end";

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

		const pill = jumpToLatestPill(this.options.newCount?.() ?? 0, this.options.keyLabel(), viewportWidth);
		const pillWidth = visibleWidth(pill);
		if (pillWidth === 0) return [""];
		const leftPadding = " ".repeat(Math.floor((viewportWidth - pillWidth) / 2));
		return [`${leftPadding}${hyperlink(pill, TRANSCRIPT_JUMP_TO_END_URL)}`];
	}
}
