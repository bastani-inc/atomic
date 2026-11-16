import { hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { Key, matchesKey, truncateToWidth } from "./text-helpers.js";

export const WORKFLOWS_EMPTY_MESSAGE = "No workflows in this session.";

export function renderWorkflowsEmptySheet(width: number, theme: GraphTheme): string[] {
	const safe = Math.max(1, Math.floor(width));
	const edge = hexToAnsi(theme.borderDim);
	const text = hexToAnsi(theme.text);
	const dim = hexToAnsi(theme.dim);
	return [
		`${edge}${"\u2594".repeat(safe)}${RESET}`,
		truncateToWidth(`   ${text}${WORKFLOWS_EMPTY_MESSAGE}${RESET}`, safe),
		"",
		truncateToWidth(`   ${dim}esc close${RESET}`, safe),
	];
}

export function closesWorkflowsEmptySheet(data: string): boolean {
	return matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"));
}
