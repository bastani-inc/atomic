import { stripVTControlCharacters } from "node:util";
import { theme } from "../theme/theme.js";
import { USER_PROMPT_ZONE_START } from "./user-message.ts";

/**
 * Counts what arrived in a transcript since the reader scrolled away from its live end. Observe it on every frame:
 * while the reader follows, the baseline moves with the transcript; once they scroll up, it stays where they left.
 */
export class NewMessageCounter {
	private baseline: number | undefined;
	private latest = 0;

	observe(following: boolean, count: number): void {
		this.latest = count;
		if (following || this.baseline === undefined || count < this.baseline) this.baseline = count;
	}

	historyPrepended(count: number): void {
		this.latest += count;
		if (this.baseline !== undefined) this.baseline += count;
	}

	/** Messages that arrived since the reader stopped following; 0 while they follow. */
	get count(): number {
		return this.baseline === undefined ? 0 : Math.max(0, this.latest - this.baseline);
	}
}

/** `↓ 3 new messages · ctrl+end`, or `↓ jump to bottom · ctrl+end` while nothing new has arrived. */
export function jumpToLatestLabel(newCount: number, keyLabel: string): string {
	const what = newCount > 0 ? `↓ ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "↓ jump to bottom";
	return keyLabel.length > 0 ? `${what} · ${keyLabel}` : what;
}

/**
 * The prompt that started the turn being read, pinned over the transcript while it is scrolled up: one dim line
 * marked `↑`, without the prompt's own styling.
 */
export function pinnedPromptLine(promptRow: string): string {
	const text = stripVTControlCharacters(promptRow).trim();
	return `${theme.fg("dim", "↑ ")}${theme.fg("muted", text)}`;
}

/** Whether a transcript row starts a user prompt's zone, as `UserMessageComponent` marks it. */
export function isUserPromptRow(row: string): boolean {
	return row.startsWith(USER_PROMPT_ZONE_START);
}

/** The main chat's pinned-prompt rule, for `TuiAltScreen`. */
export const PINNED_PROMPT = { isPrompt: isUserPromptRow, render: pinnedPromptLine } as const;
