import { stripVTControlCharacters } from "node:util";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const NEEDS_TEXT_CHANGE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const NEEDS_LINE_CHANGE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function inertDisplayText(text: string): string {
	if (!NEEDS_TEXT_CHANGE.test(text)) return text;
	return sanitizeToolDisplayText(stripVTControlCharacters(text).replace(/\r\n/g, "\n")).replace(
		BIDI_CONTROLS,
		(char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase()}>`,
	);
}

export function inertDisplayLine(text: string): string {
	if (!NEEDS_LINE_CHANGE.test(text)) return text;
	return inertDisplayText(text).replace(/\n/g, " ");
}
