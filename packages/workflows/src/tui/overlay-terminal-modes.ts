/**
 * Terminal-mode seams for the workflow graph overlay: raw mouse-scroll
 * reporting and autowrap (DECAWM) escape sequences for the local TTY, plus
 * extraction of the isolated host's remote terminal-control capability.
 *
 * cross-ref: src/tui/overlay-adapter.ts (sole consumer)
 */

import type {
  PiCustomOverlayFactoryTui,
  PiRemoteTerminalControl,
} from "../extension/wiring.js";

const MOUSE_SCROLL_TRACKING_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_SCROLL_TRACKING_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const TERMINAL_AUTOWRAP_ON = "\x1b[?7h";
const TERMINAL_AUTOWRAP_OFF = "\x1b[?7l";

export interface OverlayTerminalOutput {
  platform: NodeJS.Platform;
  isTTY: boolean | undefined;
  write(data: string): void;
}

export function setMouseScrollTracking(enabled: boolean, output: OverlayTerminalOutput): void {
  if (!output.isTTY) return;
  output.write(enabled ? MOUSE_SCROLL_TRACKING_ON : MOUSE_SCROLL_TRACKING_OFF);
}

export function setTerminalAutowrap(enabled: boolean, output: OverlayTerminalOutput): void {
  if (output.platform !== "win32" || !output.isTTY) return;
  output.write(enabled ? TERMINAL_AUTOWRAP_ON : TERMINAL_AUTOWRAP_OFF);
}

/**
 * Extract the host's remote terminal-control capability from the factory TUI —
 * present in isolated interactive mode (drives the real host TTY over the
 * allowlisted engine protocol); `null` for non-isolated hosts and test seams.
 */
export function remoteTerminalControlFrom(tui: PiCustomOverlayFactoryTui): PiRemoteTerminalControl | null {
  const terminal = tui.terminal;
  if (terminal === undefined || typeof terminal.setMouseScrollTracking !== "function" || typeof terminal.setAutowrap !== "function") {
    return null;
  }
  return {
    setMouseScrollTracking: terminal.setMouseScrollTracking.bind(terminal),
    setAutowrap: terminal.setAutowrap.bind(terminal),
  };
}
