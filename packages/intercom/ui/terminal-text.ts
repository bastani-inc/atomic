import { terminalDisplayText } from "@bastani/atomic";
import { replaceControlCharacters } from "@bastani/atomic-tui";

/** Make peer-supplied text inert for the terminal, keeping its newlines and tabs. */
export function terminalSafeText(text: string): string {
  return terminalDisplayText(text);
}

/** Make peer-supplied text inert for the terminal as a single line. */
export function terminalSafeLabel(text: string): string {
  return replaceControlCharacters(terminalDisplayText(text));
}
