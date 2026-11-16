/**
 * The sheet `/workflows` shows when the session has no workflow runs: a top edge, one line saying so, and the key that
 * closes it. It replaces the editor in place, like the run list, and closes on Esc, Enter or Ctrl+C.
 */

import { hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { Key, matchesKey, truncateToWidth } from "./text-helpers.js";

export const WORKFLOWS_EMPTY_MESSAGE = "No workflows in this session.";

/** The sheet's rows at `width`, styled with the graph theme. */
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

/** Whether a key closes the sheet. */
export function closesWorkflowsEmptySheet(data: string): boolean {
	return matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"));
}
