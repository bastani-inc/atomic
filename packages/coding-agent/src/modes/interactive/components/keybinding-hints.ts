/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { clickableKeysHint, getKeybindings, type HintKeyPart, type Keybinding, type KeyId } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { hintKeyParts } from "./nav-keys.ts";

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

/** The keys of `keybinding` as a hint names them, each with the key a click on its text presses. */
function keyParts(keybinding: Keybinding, style = (text: string) => theme.fg("dim", text)): HintKeyPart[] {
	const keys = getKeybindings().getKeys(keybinding);
	return keys.map((key, index) => ({
		text: style(`${formatKeyText(key)}${index < keys.length - 1 ? "/" : ""}`),
		key,
	}));
}

/**
 * `esc Cancel` with no style of its own, for text styled as a whole, such as a loader's message: the keys of
 * `keybinding` and what they do. A click on the hint presses its key.
 */
export function keyTextHint(keybinding: Keybinding, description: string): string {
	return clickableKeysHint(
		keyParts(keybinding, (text) => text),
		` ${formatHintLabel(description)}`,
	);
}

/** `ctrl+o expand`: the keys of `keybinding` and what they do. A click on the hint presses its key. */
export function keyHint(keybinding: Keybinding, description: string): string {
	const parts = keyParts(keybinding);
	const label = theme.fg("muted", ` ${formatHintLabel(description)}`);
	return parts.length > 0 ? clickableKeysHint(parts, label) : theme.fg("dim", "") + label;
}

export function keyHintIfBound(keybinding: Keybinding, description: string): string {
	const parts = keyParts(keybinding);
	if (parts.length === 0) return "";
	return clickableKeysHint(parts, theme.fg("muted", ` ${formatHintLabel(description)}`));
}

export function parenthesizedKeyHint(keybinding: Keybinding, description: string, prefix?: string): string {
	const hint = keyHintIfBound(keybinding, description);
	if (!hint) return prefix ? theme.fg("muted", `(${prefix})`) : "";
	return theme.fg("muted", `(${prefix ? `${prefix}, ` : ""}`) + hint + theme.fg("muted", ")");
}

/** A hint for a key that is not a keybinding, such as `↑↓ navigate`. A click on a key's text presses that key. */
export function rawKeyHint(key: string, description: string): string {
	const parts = hintKeyParts(formatKeyText(key)).map((part) => ({ ...part, text: theme.fg("dim", part.text) }));
	return clickableKeysHint(parts, theme.fg("muted", ` ${formatHintLabel(description)}`));
}
