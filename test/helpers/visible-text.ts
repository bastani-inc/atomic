import { stripVTControlCharacters as stripControlSequences } from "node:util";
import { stripHintMarkers } from "@bastani/atomic-tui";

/**
 * `text` as a terminal shows it: without control sequences and without the zero-width markers a clickable key hint
 * carries, which `node:util`'s `stripVTControlCharacters` leaves in place.
 */
export function stripVTControlCharacters(text: string): string {
	return stripControlSequences(stripHintMarkers(text));
}
