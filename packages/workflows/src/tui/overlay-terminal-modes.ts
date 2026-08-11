/**
 * Terminal-mode seams for the workflow graph overlay: autowrap (DECAWM)
 * escape sequences for the local TTY, plus extraction of the isolated host's
 * remote autowrap capability.
 *
 * Fullscreen pi-tui owns mouse reporting and application selection; workflow
 * overlays do not toggle that terminal mode.
 *
 * cross-ref: src/tui/overlay-adapter.ts (sole consumer)
 */

import type { PiCustomOverlayFactoryTui } from "../extension/wiring.js";

const TERMINAL_AUTOWRAP_ON = "\x1b[?7h";
const TERMINAL_AUTOWRAP_OFF = "\x1b[?7l";

export interface OverlayTerminalOutput {
	platform: NodeJS.Platform;
	isTTY: boolean | undefined;
	write(data: string): void;
}

export function setTerminalAutowrap(enabled: boolean, output: OverlayTerminalOutput): void {
	if (output.platform !== "win32" || !output.isTTY) return;
	output.write(enabled ? TERMINAL_AUTOWRAP_ON : TERMINAL_AUTOWRAP_OFF);
}

/**
 * Extract the host's remote autowrap capability from the factory TUI — present
 * in isolated interactive mode (drives the real host TTY over the allowlisted
 * engine protocol); `null` for non-isolated hosts and test seams.
 */
export function remoteTerminalControlFrom(
	tui: PiCustomOverlayFactoryTui,
): { setAutowrap(enabled: boolean): void } | null {
	const terminal = tui.terminal;
	if (terminal === undefined || typeof terminal.setAutowrap !== "function") return null;
	return { setAutowrap: terminal.setAutowrap.bind(terminal) };
}
