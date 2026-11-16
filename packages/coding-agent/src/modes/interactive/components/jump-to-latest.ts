import { stripVTControlCharacters } from "node:util";
import { theme } from "../theme/theme.js";
import { USER_PROMPT_ZONE_START } from "./user-message.ts";

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

	get count(): number {
		return this.baseline === undefined ? 0 : Math.max(0, this.latest - this.baseline);
	}
}

export function jumpToLatestLabel(newCount: number, keyLabel: string): string {
	const what = newCount > 0 ? `↓ ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "↓ jump to bottom";
	return keyLabel.length > 0 ? `${what} · ${keyLabel}` : what;
}

export function pinnedPromptLine(promptRow: string): string {
	const text = stripVTControlCharacters(promptRow).trim();
	return `${theme.fg("dim", "↑ ")}${theme.fg("muted", text)}`;
}

export function isUserPromptRow(row: string): boolean {
	return row.startsWith(USER_PROMPT_ZONE_START);
}

export const PINNED_PROMPT = { isPrompt: isUserPromptRow, render: pinnedPromptLine } as const;
