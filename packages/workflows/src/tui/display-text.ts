/**
 * Untrusted text made safe to paint: run and stage names, outputs, failure messages, artifact paths and diagnostics come
 * from workflow authors, models and tools, and a raw escape sequence in any of them would reach the terminal as a live
 * command (a clipboard write, a screen clear, a title change).
 */

import { stripVTControlCharacters } from "node:util";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
/** Anything {@link inertDisplayText} would change: control characters other than newline, and bidi controls. */
const NEEDS_TEXT_CHANGE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
/** Anything {@link inertDisplayLine} would change: the same, and line breaks. */
const NEEDS_LINE_CHANGE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/**
 * `text` with its escape sequences removed, every other control character shown as `\xNN`, tabs expanded and
 * bidirectional embeddings, overrides and isolates shown as `<U+XXXX>`. Newlines are kept.
 */
export function inertDisplayText(text: string): string {
	// Names and messages are almost always plain: they are returned as they are, without a copy.
	if (!NEEDS_TEXT_CHANGE.test(text)) return text;
	return sanitizeToolDisplayText(stripVTControlCharacters(text)).replace(
		BIDI_CONTROLS,
		(char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase()}>`,
	);
}

/** {@link inertDisplayText} on one line: newlines become spaces. */
export function inertDisplayLine(text: string): string {
	if (!NEEDS_LINE_CHANGE.test(text)) return text;
	return inertDisplayText(text).replace(/\r?\n/g, " ");
}
