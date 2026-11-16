/**
 * Untrusted text made safe to paint: run and stage names, outputs, failure messages, artifact paths and diagnostics come
 * from workflow authors, models and tools, and a raw escape sequence in any of them would reach the terminal as a live
 * command (a clipboard write, a screen clear, a title change).
 */

import { stripVTControlCharacters } from "node:util";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` with its escape sequences removed, every other control character shown as `\xNN`, tabs expanded and
 * bidirectional embeddings, overrides and isolates shown as `<U+XXXX>`. Newlines are kept.
 */
export function inertDisplayText(text: string): string {
	return sanitizeToolDisplayText(stripVTControlCharacters(text)).replace(
		BIDI_CONTROLS,
		(char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase()}>`,
	);
}

/** {@link inertDisplayText} on one line: newlines become spaces. */
export function inertDisplayLine(text: string): string {
	return inertDisplayText(text).replace(/\r?\n/g, " ");
}
