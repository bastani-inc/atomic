import { stripVTControlCharacters as stripControlSequences } from "node:util";
import { stripHintMarkers } from "@bastani/atomic-tui";
import { stripAnsi as stripAnsiCodes } from "../../src/utils/ansi.ts";

/**
 * `text` as a terminal shows it: without control sequences and without the zero-width markers a clickable key hint
 * carries, which `node:util`'s `stripVTControlCharacters` leaves in place.
 */
export function stripVTControlCharacters(text: string): string {
	return stripControlSequences(stripHintMarkers(text));
}

/** `stripAnsi` for rendered text: it also drops the zero-width markers a clickable key hint carries. */
export function stripAnsi(text: string): string {
	return stripAnsiCodes(stripHintMarkers(text));
}
