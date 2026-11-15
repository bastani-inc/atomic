import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

// C0 and C1 control characters other than tab and newline.
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Make peer-supplied text inert for the terminal, keeping its newlines and tabs. */
export function terminalSafeText(text: string): string {
  return stripTerminalSequences(text).replace(UNSAFE_CONTROL_CHARACTERS, "");
}

/** Make peer-supplied text inert for the terminal as a single line. */
export function terminalSafeLabel(text: string): string {
  return replaceControlCharacters(stripTerminalSequences(text));
}
