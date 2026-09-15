/**
 * Shared oracle for display-escaping sinks.
 *
 * The escaping sinks treat a raw tab as a control; that policy is pinned by
 * `questionnaire-display-controls` through its literal `\x09` assertion rather
 * than by every sink here. The generic tool-result STRIP sink
 * (`render-utils.ts`, out of scope) keeps tab as whitespace, so its oracle
 * opts out with `allowTab: true`.
 */
import assert from "node:assert/strict";

export const HOSTILE_CONTROLS = [
	["OSC-BEL", "\x1b]0;PREVIEW-BEL\x07"],
	["OSC-ST", "\x1b]0;PREVIEW-ST\x1b\\"],
	["CSI", "\x1b[2J"],
	["C1", "\x9b2J\x9d0;PREVIEW-C1\x9c"],
	["SGR", "\x1b[38;2;1;2;3m"],
	["C0", "\x00\x08\r\x7f\x85\t"],
] as const;

export const RAW_CONTROL_PATTERN = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const RAW_CONTROL_PATTERN_ALLOW_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export interface AssertNoRawControlsOptions {
	readonly allowSgr?: boolean;
	readonly allowTab?: boolean;
	readonly markers?: readonly string[];
	readonly message?: string;
}

/** Strip trusted markers/SGR, then assert no raw C0/C1 remain. Returns the normalized text. */
export function assertNoRawControls(text: string, options: AssertNoRawControlsOptions = {}): string {
	let normalized = text;
	for (const marker of options.markers ?? []) {
		normalized = normalized.replaceAll(marker, "");
	}
	if (options.allowSgr) {
		normalized = normalized.replace(/\x1b\[[0-9;]*m/g, "");
	}
	const pattern = options.allowTab ? RAW_CONTROL_PATTERN_ALLOW_TAB : RAW_CONTROL_PATTERN;
	assert.doesNotMatch(normalized, pattern, options.message);
	return normalized;
}
