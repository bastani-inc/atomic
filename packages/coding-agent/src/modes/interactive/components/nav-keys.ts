/**
 * The navigation vocabulary every chat, list and graph screen shares: how a key is named in a hint, the one dim hint
 * line a screen shows, the `?` key overlay, and the two-press confirmation that `x` and Ctrl+X Ctrl+K use.
 */

import { type EditorAutocompleteHintEntry, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";

/** What a screen needs of the keybindings manager: matching, and the keys an action resolves to. */
export interface NavKeybindings {
	matches(data: string, action: string): boolean;
	getKeys?(action: string): readonly string[];
}

/** One key of a screen: the action it is bound to (its label follows a remap) or a fixed key, and what it does. */
export interface NavKey {
	/** Keybinding id whose resolved keys name this entry. */
	readonly action?: string;
	/** Display text when the key is not a configurable action, such as `pgup/pgdn`. */
	readonly keys?: string;
	readonly label: string;
}

/** Colors a hint line or key overlay is painted with, so the workflow graph can use its own theme. */
export interface NavKeyStyle {
	dim(text: string): string;
	text(text: string): string;
	muted(text: string): string;
	border(text: string): string;
	bold(text: string): string;
}

const KEY_GLYPHS: Record<string, string> = {
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	escape: "esc",
	esc: "esc",
	enter: "enter",
	return: "enter",
	space: "space",
	backspace: "backspace",
	pageup: "pgup",
	pagedown: "pgdn",
	home: "home",
	end: "end",
	tab: "tab",
	delete: "del",
};

/** `ctrl+shift+left` → `ctrl+shift+←`; `up` → `↑`. */
export function navKeyText(key: string): string {
	return key
		.split("+")
		.map((part) => KEY_GLYPHS[part.toLowerCase()] ?? part.toLowerCase())
		.join("+");
}

/**
 * The resolved keys of an action as a hint shows them: arrows as glyphs and paired arrows merged, so `up`+`down`
 * reads `↑↓` and `enter`+`right` reads `enter/→`. An unbound action has no text.
 */
export function navActionText(keybindings: NavKeybindings | undefined, action: string): string {
	const keys = keybindings?.getKeys?.(action) ?? [];
	return keys.map(navKeyText).join("/");
}

/**
 * The text one entry shows for its keys; empty when its action is unbound. Keys in `taken` belong to an earlier entry
 * of the same screen, which handles them first, so they are left out; the entry's own keys are added to it.
 */
export function navEntryKeys(keybindings: NavKeybindings | undefined, entry: NavKey, taken?: Set<string>): string {
	if (entry.action === undefined) return entry.keys ?? "";
	const keys = (keybindings?.getKeys?.(entry.action) ?? []).filter((key) => !taken?.has(key));
	for (const key of keys) taken?.add(key);
	return keys.map(navKeyText).join("/");
}

/**
 * A screen's single dim hint line: `key label · key label`. Entries whose action is unbound are left out, and entries
 * are dropped from the end, never cut mid-word, until the line fits.
 */
export function renderNavHintLine(
	entries: readonly NavKey[],
	width: number,
	style: NavKeyStyle,
	keybindings: NavKeybindings | undefined,
	indent = 2,
): string {
	const taken = new Set<string>();
	const parts = entries.flatMap((entry) => {
		const keys = navEntryKeys(keybindings, entry, taken);
		return keys ? [`${keys} ${entry.label}`] : [];
	});
	const room = Math.max(1, width - indent);
	while (parts.length > 1 && visibleWidth(parts.join(" · ")) > room) parts.pop();
	const joined = parts.join(" · ");
	const line = visibleWidth(joined) <= room ? joined : truncateToWidth(joined, room);
	return style.dim(" ".repeat(Math.min(indent, Math.max(0, width - visibleWidth(line)))) + line);
}

/**
 * The `?` overlay: a rounded box titled `keys` that lists every key of the screen, one per row, keys in `text` and
 * what they do in `muted`. Narrow terminals drop the frame and keep the rows.
 */
export function renderNavKeyOverlay(
	title: string,
	entries: readonly NavKey[],
	width: number,
	style: NavKeyStyle,
	keybindings: NavKeybindings | undefined,
): string[] {
	const taken = new Set<string>();
	const rows = entries.flatMap((entry) => {
		if (entry.action === "app.keys.help") return [];
		const keys = navEntryKeys(keybindings, entry, taken);
		return keys ? [{ keys, label: entry.label }] : [];
	});
	rows.push({ keys: `esc/${navActionText(keybindings, "app.keys.help") || "?"}`, label: "close this help" });
	const keyWidth = Math.min(18, Math.max(...rows.map((row) => visibleWidth(row.keys))));
	const framed = width >= 24;
	const inner = Math.max(1, width - (framed ? 4 : 0));
	const body = rows.map((row) => {
		const keys = truncateToWidth(row.keys, keyWidth);
		const line =
			style.text(keys) +
			" ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2)) +
			style.muted(truncateToWidth(row.label, Math.max(1, inner - keyWidth - 2)));
		return truncateToWidth(line, inner);
	});
	if (!framed) return [style.bold(truncateToWidth(title, width)), ...body];
	const heading = ` ${truncateToWidth(title, Math.max(1, width - 6))} `;
	return [
		style.border("╭─") +
			style.bold(heading) +
			style.border(`${"─".repeat(Math.max(0, width - visibleWidth(heading) - 3))}╮`),
		...body.map(
			(line) => style.border("│ ") + line + " ".repeat(Math.max(0, inner - visibleWidth(line))) + style.border(" │"),
		),
		style.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
	];
}

/** How long a first `x` or Ctrl+X Ctrl+K waits for the confirming second press. */
export const NAV_CONFIRM_WINDOW_MS = 3000;

/**
 * Two presses of the same key on the same target within {@link NAV_CONFIRM_WINDOW_MS}. The first press arms it and
 * returns `false`; a second press on that target in time returns `true` and disarms it.
 */
export class TwoPressConfirm {
	private armed?: { target: string; at: number };
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}
	press(target: string): boolean {
		const at = this.now();
		if (this.armed?.target === target && at - this.armed.at <= NAV_CONFIRM_WINDOW_MS) {
			this.armed = undefined;
			return true;
		}
		this.armed = { target, at };
		return false;
	}
	/** The target waiting for its second press, while the window is open. */
	pending(): string | undefined {
		if (this.armed && this.now() - this.armed.at <= NAV_CONFIRM_WINDOW_MS) return this.armed.target;
		this.armed = undefined;
		return undefined;
	}
	reset(): void {
		this.armed = undefined;
	}
}

/** Whether `data` is the `?` key of the overlay. */
export function isNavHelpKey(keybindings: NavKeybindings | undefined, data: string): boolean {
	return keybindings?.matches(data, "app.keys.help") === true;
}

/**
 * The one hint line under an editor's @ and / menus: the keys that work for the open menu, named as the user's
 * keybindings name them. A narrow line gives up the select keys before complete, run and close. The main chat, stage
 * chats and subagent views all draw it with this function, each in its own colours.
 */
export function renderAutocompleteHintLine(
	entries: readonly EditorAutocompleteHintEntry[],
	width: number,
	keybindings: NavKeybindings,
	style: NavKeyStyle,
): string {
	const kept = entries.flatMap((entry) => {
		const keys = (
			entry.resolvedKeys ??
			entry.actions
				.map((action) => keybindings.getKeys?.(action)?.[0])
				.filter((key): key is string => key !== undefined)
		).map(navKeyText);
		if (keys.length === 0) return [];
		const text = keys.every((key) => key === "↑" || key === "↓") ? keys.join("") : keys.join("/");
		return [{ key: { keys: text, label: entry.label } satisfies NavKey, essential: entry.essential === true }];
	});
	const room = Math.max(1, width - 2);
	const lineWidth = () => visibleWidth(kept.map(({ key }) => `${key.keys} ${key.label}`).join(" · "));
	while (kept.length > 1 && lineWidth() > room) {
		const optional = kept.findIndex((entry) => !entry.essential);
		kept.splice(optional >= 0 ? optional : 0, 1);
	}
	return renderNavHintLine(
		kept.map(({ key }) => key),
		width,
		style,
		keybindings,
	);
}
