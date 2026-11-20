/**
 * The navigation vocabulary every chat, list and graph screen shares: how a key is named in a hint, the one dim hint
 * line a screen shows, the `?` key overlay, and the two-press confirmation that `x` and Ctrl+X Ctrl+K use.
 */

import {
	clickableKeysHint,
	type EditorAutocompleteHintEntry,
	type HintKeyPart,
	hintKeyParts,
	type KeyId,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";

export { clickableHintText, clickableKeyTextHint, hintKeyParts, slashCommandHint } from "@bastani/atomic-tui";

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

/** Colors a hint line or key overlay is painted with. */
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

/** The first bound key as displayed. A slash can be that key, not a separator. */
export function navFirstKeyText(keybindings: NavKeybindings, action: string): string {
	return navKeyText(keybindings.getKeys?.(action)?.[0] ?? "");
}

/**
 * The text one entry shows for its keys; empty when its action is unbound. Keys in `taken` belong to an earlier entry
 * of the same screen, which handles them first, so they are left out; the entry's own keys are added to it.
 */
export function navEntryKeys(keybindings: NavKeybindings | undefined, entry: NavKey, taken?: Set<string>): string {
	return navEntryKeyParts(keybindings, entry, taken)
		.map((part) => part.text)
		.join("");
}

/** {@link navEntryKeys} split by key, each part with the key a click on it presses. */
export function navEntryKeyParts(
	keybindings: NavKeybindings | undefined,
	entry: NavKey,
	taken?: Set<string>,
): HintKeyPart[] {
	if (entry.action === undefined) return hintKeyParts(entry.keys ?? "");
	const keys = (keybindings?.getKeys?.(entry.action) ?? []).filter((key) => !taken?.has(key));
	for (const key of keys) taken?.add(key);
	return boundKeyParts(keys);
}

function boundKeyParts(keys: readonly string[]): HintKeyPart[] {
	return keys.map((key, index) => ({
		text: `${navKeyText(key)}${index < keys.length - 1 ? "/" : ""}`,
		key: key as KeyId,
	}));
}

const WAY_OUT_KEY_RE = /(?:^|\/)(?:esc|escape|←|left)(?:$|\/)/i;
/** Esc in a chat acts on the agent's turn and stays in the chat: it is no way out. */
const TURN_KEY_LABELS: ReadonlySet<string> = new Set(["interrupt", "to interrupt", "to pause"]);

function navEntryPriority(entry: NavKey, keys: string): number {
	if (
		entry.action === "app.nav.back" ||
		entry.action === "tui.select.cancel" ||
		(WAY_OUT_KEY_RE.test(keys) && !TURN_KEY_LABELS.has(entry.label))
	) {
		return 2;
	}
	if (entry.action === "app.keys.help" || (keys === "?" && entry.label === "keys")) {
		return 1;
	}
	return 0;
}

export function renderNavHintLine(
	entries: readonly NavKey[],
	width: number,
	style: NavKeyStyle,
	keybindings: NavKeybindings | undefined,
	indent = 2,
	options: { readonly compact?: boolean } = {},
): string {
	const taken = new Set<string>();
	const items = entries.flatMap((entry) => {
		const parts = navEntryKeyParts(keybindings, entry, taken);
		const keys = parts.map((part) => part.text).join("");
		return keys
			? [
					{
						text: `${keys} ${entry.label}`,
						hint: clickableKeysHint(parts, ` ${entry.label}`),
						priority: navEntryPriority(entry, keys),
					},
				]
			: [];
	});
	const separator = " · ";
	const joined = () => items.map((item) => item.text).join(separator);
	const joinedHints = () => items.map((item) => item.hint).join(separator);
	let padding = indent;
	if (options.compact && visibleWidth(joined()) > width - padding) {
		padding = 0;
	}
	const room = Math.max(1, width - padding);
	while (items.length > 1 && visibleWidth(joined()) > room) {
		let minPriority = items[0]!.priority;
		for (const item of items) {
			if (item.priority < minPriority) minPriority = item.priority;
		}
		let dropIndex = items.length - 1;
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i]!.priority === minPriority) {
				dropIndex = i;
				break;
			}
		}
		items.splice(dropIndex, 1);
	}
	const joinedText = joinedHints();
	const line = visibleWidth(joinedText) <= room ? joinedText : truncateToWidth(joinedText, room);
	const lead = options.compact && visibleWidth(line) <= width - indent ? indent : padding;
	return style.dim(" ".repeat(Math.min(lead, Math.max(0, width - visibleWidth(line)))) + line);
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
	closeKey: "escape" | "tui.select.cancel" = "escape",
): string[] {
	const taken = new Set<string>();
	const rows = entries.flatMap((entry) => {
		if (entry.action === "app.keys.help") return [];
		const parts = navEntryKeyParts(keybindings, entry, taken);
		return parts.length > 0 ? [{ parts, label: entry.label }] : [];
	});
	const cancelKeys = closeKey === "escape" ? ["escape"] : (keybindings?.getKeys?.(closeKey) ?? ["escape"]);
	const helpKeys = keybindings?.getKeys?.("app.keys.help") ?? ["?"];
	// In selectors Ctrl+C closes the whole dialog, not just its help.
	const exits = [...new Set([...cancelKeys, ...helpKeys])].filter((key) => closeKey === "escape" || key !== "ctrl+c");
	if (exits.length > 0) rows.push({ parts: boundKeyParts(exits), label: "close this help" });
	const hints = rows.map(({ parts, label }) => ({
		keys: clickableKeysHint(parts.map((part) => ({ ...part, text: style.text(part.text) }))),
		label: clickableKeysHint([{ ...parts.at(-1)!, text: style.muted(label) }]),
	}));
	const keyWidth = Math.min(18, Math.max(...hints.map(({ keys }) => visibleWidth(keys))));
	const framed = width >= 24;
	const inner = Math.max(1, width - (framed ? 4 : 0));
	const body = hints.map((hint) => {
		const keys = truncateToWidth(hint.keys, keyWidth);
		const gap = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
		return truncateToWidth(keys + gap + truncateToWidth(hint.label, Math.max(1, inner - keyWidth - 2)), inner);
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
