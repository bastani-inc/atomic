import { stripVTControlCharacters } from "node:util";
import { sliceHead } from "@bastani/atomic";
import { sanitizeToolDisplayText, TOOL_PAYLOAD_VALUE_LIMIT } from "../shared/tool-payload-bounds.js";

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

export const NO_FAILURE_REASON = "No reason was recorded.";
const STACK_FRAME_TAIL = /(?::\d+:\d+\)?|\s\((?:native|<anonymous>|index\s+\d+)\))$/;
const BARE_COLON_LOC = /^:\d+:\d+\)?$/;

function stripControlsIfPresent(line: string): string {
	return line.includes("\x1b") || line.includes("\x9b") ? stripVTControlCharacters(line) : line;
}

export function isStackFrame(line: string): boolean {
	const plain = stripControlsIfPresent(line).trim();
	if (!plain.startsWith("at ") && !plain.startsWith("at\t")) return false;
	const rest = plain.slice(2).trimStart();
	if (rest.length === 0) return false;
	if (rest === "<anonymous>" || rest === "async <anonymous>") return true;
	if (BARE_COLON_LOC.test(rest)) return false;
	return STACK_FRAME_TAIL.test(rest);
}

export function summarizeFailureText(text: string | undefined): { reason: string; frames: number } {
	const raw = text ?? "";
	const bounded = raw.length > TOOL_PAYLOAD_VALUE_LIMIT * 4 ? sliceHead(raw, TOOL_PAYLOAD_VALUE_LIMIT * 4) : raw;
	const lines = bounded.split(/\r?\n/);
	const frames = lines.filter(isStackFrame).length;
	const first = lines
		.map((line) => stripControlsIfPresent(line).trim())
		.find((line) => line.length > 0 && !isStackFrame(line));
	if (first === undefined) return { reason: NO_FAILURE_REASON, frames };
	const boundedFirst = first.length > TOOL_PAYLOAD_VALUE_LIMIT ? sliceHead(first, TOOL_PAYLOAD_VALUE_LIMIT) : first;
	const reason = boundedFirst.replace(/^(?:Uncaught\s+)?Error:\s*/, "").trim();
	return { reason: inertDisplayLine(reason.length > 0 ? reason : boundedFirst), frames };
}

export function withoutStackFrames(text: string): { kept: string[]; frames: number } {
	const lines = text.split(/\r?\n/);
	const kept = lines.filter((line) => !isStackFrame(line));
	return { kept, frames: lines.length - kept.length };
}
