/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	/** @deprecated Key labels are always normalized for display. */
	capitalize?: boolean;
}

const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "ctrl",
	control: "ctrl",
	cmd: "cmd",
	command: "cmd",
	shift: "shift",
	alt: "alt",
	option: "alt",
	meta: "meta",
};

const SPECIAL_KEY_LABELS: Record<string, string> = {
	enter: "enter",
	return: "enter",
	esc: "esc",
	escape: "esc",
	space: "space",
	tab: "tab",
	backspace: "backspace",
	delete: "delete",
	del: "delete",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	home: "home",
	end: "end",
	pageup: "pageup",
	pagedown: "pagedown",
};

function formatKeyPart(part: string, _options: KeyTextFormatOptions): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const special = SPECIAL_KEY_LABELS[lower];
	if (special) return special;
	if (/^f\d+$/i.test(part)) return lower;
	if (/^[a-z]$/i.test(part)) return lower;
	return part.toLowerCase();
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

function formatHintLabel(description: string): string {
	return description;
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${formatHintLabel(description)}`);
}

export function keyHintIfBound(keybinding: Keybinding, description: string): string {
	const text = keyText(keybinding);
	if (!text) return "";
	return theme.fg("dim", text) + theme.fg("muted", ` ${formatHintLabel(description)}`);
}

export function parenthesizedKeyHint(
	keybinding: Keybinding,
	description: string,
	prefix?: string,
): string {
	const hint = keyHintIfBound(keybinding, description);
	if (!hint) return prefix ? theme.fg("muted", `(${prefix})`) : "";
	return theme.fg("muted", `(${prefix ? `${prefix}, ` : ""}`) + hint + theme.fg("muted", ")");
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${formatHintLabel(description)}`);
}
