import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { USER_PROMPT_ZONE_START } from "./user-message.ts";

export class NewMessageCounter {
	private baseline: number | undefined;
	private latest = 0;
	private readEpoch = 0;

	get epoch(): number {
		return this.readEpoch;
	}

	observe(following: boolean, count: number): void {
		if (following || this.baseline === undefined) {
			this.baseline = count;
			this.latest = count;
			this.readEpoch += 1;
			return;
		}
		if (count < this.latest) {
			this.baseline = count - this.count;
		}
		this.latest = count;
	}

	historyPrepended(count: number): void {
		this.latest += count;
		if (this.baseline !== undefined) this.baseline += count;
	}

	replaced(count: number): void {
		if (this.baseline !== undefined) {
			this.baseline = count - this.count;
		}
		this.latest = count;
	}

	compactionRefreshed(count: number): void {
		this.replaced(count);
	}

	retract(count: number): void {
		if (count <= 0) return;
		this.latest = Math.max(0, this.latest - count);
		if (this.baseline !== undefined && this.baseline > this.latest) {
			this.baseline = this.latest;
		}
	}

	reset(): void {
		this.baseline = undefined;
		this.latest = 0;
		this.readEpoch += 1;
	}

	get count(): number {
		return this.baseline === undefined ? 0 : Math.max(0, this.latest - this.baseline);
	}
}

export function jumpToLatestLabel(newCount: number, keyLabel: string): string {
	const what = newCount > 0 ? `↓ ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "↓ jump to bottom";
	return keyLabel.length > 0 ? `${what} · ${keyLabel}` : what;
}

export function jumpToLatestPill(newCount: number, keyLabel: string, maxWidth = Number.POSITIVE_INFINITY): string {
	const label = jumpToLatestLabel(newCount, keyLabel);
	const pill =
		visibleWidth(label) + 2 > maxWidth
			? theme.fg("text", truncateToWidth(label, Math.max(0, maxWidth)))
			: theme.fg("text", ` ${label} `);
	return process.env.NO_COLOR === undefined ? theme.bg("selectedBg", pill) : stripTerminalSequences(pill);
}

export function pinnedPromptLine(promptRow: string): string {
	const text = stripTerminalSequences(promptRow).trim();
	return `${theme.fg("dim", "↑ ")}${theme.fg("muted", text)}`;
}

export function isUserPromptRow(row: string): boolean {
	return row.startsWith(USER_PROMPT_ZONE_START);
}

export const PINNED_PROMPT = { isPrompt: isUserPromptRow, render: pinnedPromptLine } as const;
