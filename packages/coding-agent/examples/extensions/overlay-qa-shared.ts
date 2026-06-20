import type { Theme } from "@bastani/atomic";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Base overlay component with common rendering
export abstract class BaseOverlay {
	protected theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	protected box(lines: string[], width: number, title?: string): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const result: string[] = [];

		const titleStr = title ? truncateToWidth(` ${title} `, innerW) : "";
		const titleW = visibleWidth(titleStr);
		const topLine = "─".repeat(Math.floor((innerW - titleW) / 2));
		const topLine2 = "─".repeat(Math.max(0, innerW - titleW - topLine.length));
		result.push(th.fg("border", `╭${topLine}`) + th.fg("accent", titleStr) + th.fg("border", `${topLine2}╮`));

		for (const line of lines) {
			result.push(th.fg("border", "│") + truncateToWidth(line, innerW, "...", true) + th.fg("border", "│"));
		}

		result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return result;
	}

	invalidate(): void {}
	dispose(): void {}
}
