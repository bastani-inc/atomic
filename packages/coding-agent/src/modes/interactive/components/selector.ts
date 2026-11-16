import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import {
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navActionText,
	navKeyText,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "./nav-keys.ts";

/** A status colour a row's tag or marker can carry. */
export type SelectorTone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

/** One row of a picker. */
export interface SelectorItem<T> {
	/** Stable identity; selection, checked state and `initialId` refer to it. */
	readonly id: string;
	readonly value: T;
	readonly label: string;
	/** Dim text beside the label (one-line layout) or on the line under it (two-line layout). */
	readonly description?: string;
	/** Right-aligned tag, such as `current` or `default`. */
	readonly tag?: string;
	readonly tagTone?: SelectorTone;
	/**
	 * A radio mark before the label: `on` draws `●`, `off` draws `○`. Use it where one row is the current value, as in
	 * the model or theme picker. Rows without a mark draw none.
	 */
	readonly mark?: "on" | "off";
	/** Rows that cannot be chosen: drawn dim, skipped by ↑↓, refused by enter. */
	readonly disabled?: boolean;
	/** Rows with the same group are listed under a section label. Items should already be ordered by group. */
	readonly group?: string;
	/** Extra text type-to-search matches against, beside the label and description. */
	readonly searchText?: string;
}

/** A key a particular picker adds, such as ←→ for the reasoning effort in the model picker. */
export interface SelectorExtraKey<T> {
	/** Hint entry. Its keybinding action (or fixed keys) also decides whether a key press is this key. */
	readonly hint: NavKey;
	/** Whether the key does something for this row; a key that does nothing is left out of the hint. */
	readonly enabled?: (item: SelectorItem<T> | undefined) => boolean;
	/** Raw key matcher for keys that are not keybinding actions. */
	readonly matches?: (data: string) => boolean;
	readonly run: (item: SelectorItem<T> | undefined) => void;
}

export interface SelectorOptions<T> {
	readonly title?: string;
	/** Dim line under the title. */
	readonly subtitle?: string;
	readonly items: readonly SelectorItem<T>[];
	/** `two-line` puts each description on the line under its label. Default `one-line`. */
	readonly layout?: "one-line" | "two-line";
	/** `multi` adds checkboxes; space toggles and enter confirms. Default `single`. */
	readonly mode?: "single" | "multi";
	/** Show a search box that typing filters. Default `false`. */
	readonly search?: boolean;
	readonly searchPlaceholder?: string;
	readonly initialQuery?: string;
	/** Rows shown at once; the list scrolls past it. Default 10. */
	readonly maxVisible?: number;
	/** Shown when there are no rows at all. */
	readonly emptyText?: string;
	/** Number the rows `1.` `2.`; digits then choose a row when there is no search box. */
	readonly numbered?: boolean;
	/** The row selected first. Defaults to the first row marked `on`, else the first enabled row. */
	readonly initialId?: string;
	/** Rows checked first in a multi-select. */
	readonly initialChecked?: readonly string[];
	/** Hint label for enter. Default `choose` (single) or `confirm` (multi). */
	readonly confirmLabel?: string;
	/** Hint label for esc when the search is empty. Default `cancel`. */
	readonly cancelLabel?: string;
	/** Space opens a preview of the selected row; the hint shows `space <previewLabel>`. */
	readonly onPreview?: (item: SelectorItem<T>) => void;
	readonly previewLabel?: string;
	readonly extraKeys?: readonly SelectorExtraKey<T>[];
	/** Single-select: the chosen row. */
	readonly onSelect?: (item: SelectorItem<T>) => void;
	/** Multi-select: the checked rows, in list order. */
	readonly onConfirm?: (items: readonly SelectorItem<T>[]) => void;
	readonly onCancel?: () => void;
	readonly onSelectionChange?: (item: SelectorItem<T> | undefined) => void;
	/** Title shown on the `?` overlay. Default: the picker's title. */
	readonly helpTitle?: string;
	/** Keybindings to read key names and matches from. Default: the global keybindings. */
	readonly keybindings?: NavKeybindings;
	/** Colours. Default: the active theme. */
	readonly style?: SelectorStyle;
}

/** The colours a picker is painted with. */
export interface SelectorStyle extends NavKeyStyle {
	accent(text: string): string;
	tone(tone: SelectorTone, text: string): string;
}

export function themeSelectorStyle(): SelectorStyle {
	return {
		dim: (text) => theme.fg("dim", text),
		text: (text) => theme.fg("text", text),
		muted: (text) => theme.fg("muted", text),
		border: (text) => theme.fg("borderMuted", text),
		bold: (text) => theme.bold(text),
		accent: (text) => theme.fg("accent", text),
		tone: (tone, text) => theme.fg(tone, text),
	};
}

/** A plain style, for tests and for terminals without colour. */
export const PLAIN_SELECTOR_STYLE: SelectorStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	tone: (_tone, text) => text,
};

const DEFAULT_MAX_VISIBLE = 10;
const MIN_DESCRIPTION_WIDTH = 12;
const DESCRIPTION_GAP = 2;

/** Filtering, selection and checked state of a picker, without rendering. */
export class SelectorState<T> {
	readonly items: readonly SelectorItem<T>[];
	readonly mode: "single" | "multi";
	readonly maxVisible: number;
	private query = "";
	private visible: SelectorItem<T>[];
	private selected = 0;
	private top = 0;
	private readonly checked = new Set<string>();

	constructor(options: Pick<SelectorOptions<T>, "items" | "mode" | "maxVisible" | "initialId" | "initialChecked">) {
		this.items = options.items;
		this.mode = options.mode ?? "single";
		this.maxVisible = Math.max(1, options.maxVisible ?? DEFAULT_MAX_VISIBLE);
		this.visible = [...this.items];
		for (const id of options.initialChecked ?? []) this.checked.add(id);
		const initial =
			options.initialId !== undefined ? this.visible.findIndex((item) => item.id === options.initialId) : -1;
		const marked = this.visible.findIndex((item) => item.mark === "on" && !item.disabled);
		this.selected = initial >= 0 ? initial : marked >= 0 ? marked : this.firstEnabled(0, 1);
		this.scrollToSelected();
	}

	getQuery(): string {
		return this.query;
	}

	/** Rows that match the search, in list order (best match first while searching). */
	getVisible(): readonly SelectorItem<T>[] {
		return this.visible;
	}

	getSelectedIndex(): number {
		return this.selected;
	}

	getSelected(): SelectorItem<T> | undefined {
		const item = this.visible[this.selected];
		return item && !item.disabled ? item : undefined;
	}

	/** The first visible row index; rows before it scroll above the window. */
	getTop(): number {
		return this.top;
	}

	isChecked(id: string): boolean {
		return this.checked.has(id);
	}

	getChecked(): SelectorItem<T>[] {
		return this.items.filter((item) => this.checked.has(item.id));
	}

	setQuery(query: string): void {
		if (query === this.query) return;
		const previous = this.visible[this.selected]?.id;
		this.query = query;
		this.visible = query
			? fuzzyFilter([...this.items], query, (item) =>
					[item.label, item.description ?? "", item.tag ?? "", item.searchText ?? ""].join(" "),
				)
			: [...this.items];
		const kept = previous === undefined ? -1 : this.visible.findIndex((item) => item.id === previous);
		this.selected = query ? this.firstEnabled(0, 1) : kept >= 0 ? kept : this.firstEnabled(0, 1);
		this.top = 0;
		this.scrollToSelected();
	}

	/** Move by `delta` rows, wrapping at the ends unless `wrap` is false, and skipping disabled rows. */
	move(delta: number, wrap = true): void {
		const count = this.visible.length;
		if (count === 0 || delta === 0) return;
		const step = Math.sign(delta) as -1 | 1;
		if (!wrap) {
			for (let index = this.selected + step; index >= 0 && index < count; index += step) {
				if (!this.visible[index]?.disabled) {
					this.selected = index;
					this.scrollToSelected();
					return;
				}
			}
			return;
		}
		let index = this.selected;
		for (let stepIndex = 0; stepIndex < count; stepIndex++) {
			index = (index + step + count) % count;
			if (!this.visible[index]?.disabled) break;
		}
		this.selected = index;
		this.scrollToSelected();
	}

	/** Move a page up or down, clamped to the ends. */
	page(direction: -1 | 1): void {
		if (this.visible.length === 0) return;
		const target = Math.max(0, Math.min(this.visible.length - 1, this.selected + direction * this.maxVisible));
		this.selected = this.firstEnabled(target, direction === 1 ? -1 : 1);
		this.scrollToSelected();
	}

	/** Jump to the first or last enabled row. */
	edge(end: "first" | "last"): void {
		if (this.visible.length === 0) return;
		this.selected = end === "first" ? this.firstEnabled(0, 1) : this.firstEnabled(this.visible.length - 1, -1);
		this.scrollToSelected();
	}

	select(index: number): void {
		if (index < 0 || index >= this.visible.length || this.visible[index]?.disabled) return;
		this.selected = index;
		this.scrollToSelected();
	}

	toggle(id: string): void {
		if (this.checked.has(id)) this.checked.delete(id);
		else this.checked.add(id);
	}

	private firstEnabled(from: number, direction: 1 | -1): number {
		for (let index = from; index >= 0 && index < this.visible.length; index += direction) {
			if (!this.visible[index]?.disabled) return index;
		}
		return Math.max(0, Math.min(from, this.visible.length - 1));
	}

	private scrollToSelected(): void {
		if (this.selected < this.top) this.top = this.selected;
		else if (this.selected >= this.top + this.maxVisible) this.top = this.selected - this.maxVisible + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.visible.length - this.maxVisible)));
	}
}

/** The keys a picker offers for its current state, in hint order; exactly the keys that do something now. */
export function selectorHintEntries<T>(
	state: SelectorState<T>,
	options: Pick<
		SelectorOptions<T>,
		| "search"
		| "numbered"
		| "confirmLabel"
		| "cancelLabel"
		| "onPreview"
		| "previewLabel"
		| "extraKeys"
		| "keybindings"
	>,
): NavKey[] {
	const keybindings = options.keybindings ?? getKeybindings();
	const selected = state.getSelected();
	const enabledCount = state.getVisible().filter((item) => !item.disabled).length;
	const multi = state.mode === "multi";
	const entries: NavKey[] = [];
	if (enabledCount > 1) {
		const up = navActionText(keybindings, "tui.select.up");
		const down = navActionText(keybindings, "tui.select.down");
		const keys = up === "↑" && down === "↓" ? "↑↓" : [up, down].filter(Boolean).join("/");
		if (keys) entries.push({ keys, label: "select" });
	}
	if (multi && selected) entries.push({ keys: "space", label: "toggle" });
	if (!multi && selected && options.onPreview)
		entries.push({ keys: "space", label: options.previewLabel ?? "preview" });
	if (multi ? state.getChecked().length > 0 || selected !== undefined : selected) {
		entries.push({ action: "tui.select.confirm", label: options.confirmLabel ?? (multi ? "confirm" : "choose") });
	}
	for (const extra of options.extraKeys ?? []) {
		if (extra.enabled?.(selected) ?? true) entries.push(extra.hint);
	}
	if (options.search) entries.push({ keys: "type", label: "to search" });
	else if (options.numbered && enabledCount > 0) entries.push({ keys: enabledCount > 1 ? "1-9" : "1", label: "pick" });
	const cancel = firstKey(keybindings, "tui.select.cancel") || "esc";
	entries.push({ keys: cancel, label: state.getQuery() ? "clear" : (options.cancelLabel ?? "cancel") });
	if (!options.search) {
		const help = navActionText(keybindings, "app.keys.help");
		if (help) entries.push({ keys: help, label: "keys" });
	}
	return entries;
}

/**
 * Labels in the order a narrow hint gives them up: the search and help reminders first, cancel and choose last, so a
 * picker never hides how to leave it or how to choose. Labels not listed (a picker's own keys) go after `select`.
 */
const HINT_DROP_ORDER = ["to search", "keys", "pick", "preview", "select"];

/** Drop hint entries, least needed first, until the line fits `room` columns. */
export function fitHintEntries(entries: readonly NavKey[], room: number, keybindings: NavKeybindings): NavKey[] {
	const text = (entry: NavKey) =>
		`${entry.action !== undefined ? navActionText(keybindings, entry.action) : (entry.keys ?? "")} ${entry.label}`;
	const kept = [...entries];
	const width = () => visibleWidth(kept.map(text).join(" · "));
	const essential = new Set(["cancel", "clear", "choose", "confirm"]);
	while (kept.length > 1 && width() > room) {
		const byOrder = HINT_DROP_ORDER.map((label) => kept.findIndex((entry) => entry.label === label)).find(
			(index) => index >= 0,
		);
		const other = kept.findIndex((entry) => !essential.has(entry.label) && !HINT_DROP_ORDER.includes(entry.label));
		const drop = byOrder ?? (other >= 0 ? other : kept.findIndex((entry) => entry.label !== "cancel"));
		if (drop < 0) break;
		kept.splice(drop, 1);
	}
	return kept;
}

function firstKey(keybindings: NavKeybindings, action: string): string {
	const key = keybindings.getKeys?.(action)?.[0];
	return key ? navKeyText(key) : "";
}

/** The picker component: state, rendering and keys. */
export class Selector<T> implements Component, Focusable {
	readonly capturesViewportInput = true;
	readonly state: SelectorState<T>;
	private readonly options: SelectorOptions<T>;
	private readonly style: SelectorStyle;
	private readonly input?: Input;
	private showingHelp = false;
	private notice?: { text: string; tone: SelectorTone };
	/** Rendered line index of each visible row, from the last render, for mouse hits. */
	private rowLines = new Map<number, number>();
	private mousePressed?: number;
	private _focused = false;

	constructor(options: SelectorOptions<T>) {
		this.options = options;
		this.style = options.style ?? themeSelectorStyle();
		this.state = new SelectorState(options);
		if (options.search) {
			this.input = new Input({
				prompt: "⌕ ",
				placeholder: options.searchPlaceholder ?? "Search…",
				placeholderStyle: (text) => this.style.dim(text),
			});
			if (options.initialQuery) {
				this.input.setValue(options.initialQuery);
				this.state.setQuery(options.initialQuery);
			}
		}
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	/** A one-line message under the list, such as a refresh status or an error; `undefined` clears it. */
	setNotice(notice: { text: string; tone: SelectorTone } | undefined): void {
		this.notice = notice;
	}

	getSelected(): SelectorItem<T> | undefined {
		return this.state.getSelected();
	}

	/** Set the search text as if typed. */
	setQuery(query: string): void {
		this.input?.setValue(query);
		this.state.setQuery(query);
		this.options.onSelectionChange?.(this.state.getSelected());
	}

	invalidate(): void {
		this.input?.invalidate();
	}

	handleInput(data: string): void {
		const kb = this.options.keybindings ?? getKeybindings();
		if (this.showingHelp) {
			if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.keys.help")) this.showingHelp = false;
			return;
		}
		const selected = this.state.getSelected();
		const before = this.state.getSelectedIndex();
		if (kb.matches(data, "tui.select.up")) this.state.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.state.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.state.page(-1);
		else if (kb.matches(data, "tui.select.pageDown")) this.state.page(1);
		else if (!this.input && matchesKey(data, "home")) this.state.edge("first");
		else if (!this.input && matchesKey(data, "end")) this.state.edge("last");
		else if (kb.matches(data, "tui.select.cancel")) {
			if (this.state.getQuery() && !isCtrlC(data)) this.setQuery("");
			else this.options.onCancel?.();
			return;
		} else if (this.runExtraKey(kb, data, selected)) {
			return;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(kb.matches(data, "app.list.open") && !this.state.getQuery())
		) {
			this.confirm();
			return;
		} else if (data === " " && this.state.mode === "multi") {
			if (selected) this.state.toggle(selected.id);
			return;
		} else if (data === " " && this.options.onPreview) {
			if (selected) this.options.onPreview(selected);
			return;
		} else if (!this.input && kb.matches(data, "app.keys.help")) {
			this.showingHelp = true;
			return;
		} else if (!this.input && this.options.numbered && /^[1-9]$/.test(data)) {
			this.pickNumber(Number(data) - 1);
			return;
		} else if (this.input) {
			this.input.handleInput(data);
			this.state.setQuery(this.input.getValue());
		} else return;
		if (this.state.getSelectedIndex() !== before) this.options.onSelectionChange?.(this.state.getSelected());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			const before = this.state.getSelectedIndex();
			this.state.move(event.wheelDelta < 0 ? -1 : 1, false);
			const changed = this.state.getSelectedIndex() !== before;
			if (changed) this.options.onSelectionChange?.(this.state.getSelected());
			return { handled: true, render: changed };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const index = [...this.rowLines.entries()].find(([, line]) => line === event.y)?.[0];
		if (index === undefined) return undefined;
		const visible = this.state.getVisible();
		if (visible[index]?.disabled) {
			this.mousePressed = undefined;
			return { handled: true };
		}
		if (event.type === "press") {
			this.mousePressed = index;
			const before = this.state.getSelectedIndex();
			this.state.select(index);
			if (this.state.getSelectedIndex() !== before) this.options.onSelectionChange?.(this.state.getSelected());
			return { handled: true, focus: true };
		}
		const clicked = this.mousePressed ?? index;
		this.mousePressed = undefined;
		if (visible[clicked]?.disabled) return { handled: true };
		const before = this.state.getSelectedIndex();
		this.state.select(clicked);
		if (this.state.getSelectedIndex() !== before) this.options.onSelectionChange?.(this.state.getSelected());
		if (this.state.mode === "multi") {
			const item = this.state.getSelected();
			if (item) this.state.toggle(item.id);
		} else this.confirm();
		return { handled: true };
	}

	render(width: number): string[] {
		if (this.showingHelp) {
			const title = this.options.helpTitle ?? this.options.title ?? "keys";
			return renderNavKeyOverlay(
				title,
				this.helpEntries(),
				width,
				this.style,
				this.options.keybindings ?? getKeybindings(),
			);
		}
		const lines: string[] = [];
		const inner = Math.max(1, width - 2);
		if (this.options.title) {
			lines.push(
				`  ${this.style.bold(this.style.text(truncateToWidth(this.options.title, Math.max(1, inner - 1))))}`,
			);
		}
		if (this.options.subtitle) lines.push(`  ${this.style.muted(truncateToWidth(this.options.subtitle, inner))}`);
		if (this.input) lines.push(...this.renderSearch(width));
		if (lines.length > 0) lines.push("");
		this.rowLines = new Map();
		lines.push(...this.renderRows(width, lines.length));
		if (this.notice) {
			lines.push("");
			lines.push(`  ${this.style.tone(this.notice.tone, truncateToWidth(this.notice.text, inner))}`);
		}
		lines.push("");
		const keybindings = this.options.keybindings ?? getKeybindings();
		lines.push(
			renderNavHintLine(
				fitHintEntries(selectorHintEntries(this.state, this.options), width - 2, keybindings),
				width,
				this.style,
				keybindings,
			),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	private helpEntries(): NavKey[] {
		const entries = selectorHintEntries(this.state, this.options).filter((entry) => entry.label !== "keys");
		return entries;
	}

	private runExtraKey(kb: NavKeybindings, data: string, selected: SelectorItem<T> | undefined): boolean {
		for (const extra of this.options.extraKeys ?? []) {
			const hit = extra.matches
				? extra.matches(data)
				: extra.hint.action !== undefined && kb.matches(data, extra.hint.action);
			if (!hit) continue;
			if (extra.enabled?.(selected) ?? true) extra.run(selected);
			return true;
		}
		return false;
	}

	private confirm(): void {
		if (this.state.mode === "multi") {
			this.options.onConfirm?.(this.state.getChecked());
			return;
		}
		const item = this.state.getSelected();
		if (item) this.options.onSelect?.(item);
	}

	private pickNumber(index: number): void {
		const item = this.state.getVisible()[index];
		if (!item || item.disabled) return;
		this.state.select(index);
		if (this.state.mode === "multi") this.state.toggle(item.id);
		else this.options.onSelect?.(item);
	}

	private renderSearch(width: number): string[] {
		const input = this.input;
		if (!input) return [];
		const boxWidth = Math.max(8, width - 2);
		const field = Math.max(1, boxWidth - 4);
		const content = input.render(field)[0] ?? "";
		const pad = " ".repeat(Math.max(0, field - visibleWidth(content)));
		const border = this.state.getQuery() ? this.style.muted : this.style.border;
		return [
			` ${border(`╭${"─".repeat(boxWidth - 2)}╮`)}`,
			` ${border("│ ")}${content}${pad}${border(" │")}`,
			` ${border(`╰${"─".repeat(boxWidth - 2)}╯`)}`,
		];
	}

	private renderRows(width: number, firstLine: number): string[] {
		const visible = this.state.getVisible();
		const lines: string[] = [];
		if (visible.length === 0) {
			const query = this.state.getQuery();
			const text = query ? `No matches for "${query}"` : (this.options.emptyText ?? "Nothing to choose from");
			lines.push(`  ${this.style.dim(truncateToWidth(text, Math.max(1, width - 2)))}`);
			return lines;
		}
		const top = this.state.getTop();
		const end = Math.min(visible.length, top + this.state.maxVisible);
		if (top > 0) lines.push(`  ${this.style.dim(`↑ ${top} more`)}`);
		const numbered = this.options.numbered === true;
		const numberWidth = numbered ? String(visible.length).length + 2 : 0;
		const hasMarks = visible.some((item) => item.mark !== undefined);
		const multi = this.state.mode === "multi";
		const labelWidth = Math.max(...visible.slice(top, end).map((item) => visibleWidth(item.label)));
		const twoLine = this.options.layout === "two-line";
		let lastGroup: string | undefined;
		for (let index = top; index < end; index++) {
			const item = visible[index];
			if (!item) continue;
			if (item.group !== undefined && item.group !== lastGroup && !this.state.getQuery()) {
				if (lines.length > 0 && index !== top) lines.push("");
				lines.push(`  ${this.style.bold(this.style.muted(truncateToWidth(item.group, Math.max(1, width - 2))))}`);
			}
			lastGroup = item.group;
			const isSelected = index === this.state.getSelectedIndex() && !item.disabled;
			this.rowLines.set(index, firstLine + lines.length);
			const parts = this.rowParts(item, index, isSelected, numbered, numberWidth, hasMarks, multi);
			const indent = visibleWidth(parts.lead);
			const tag = item.tag ? this.style.tone(item.tagTone ?? "muted", item.tag) : "";
			const tagWidth = item.tag ? visibleWidth(item.tag) + 2 : 0;
			const room = Math.max(1, width - indent - tagWidth - 1);
			const label = truncateToWidth(item.label, room);
			let line = parts.lead + parts.label(label);
			let used = indent + visibleWidth(label);
			if (item.description && !twoLine) {
				const column = Math.min(labelWidth, Math.max(visibleWidth(label), room - MIN_DESCRIPTION_WIDTH));
				const gap = column - visibleWidth(label) + DESCRIPTION_GAP;
				const descRoom = width - used - gap - tagWidth - 1;
				if (descRoom >= MIN_DESCRIPTION_WIDTH) {
					const description = truncateToWidth(item.description.replace(/\s+/g, " "), descRoom);
					line += " ".repeat(gap) + this.style.muted(description);
					used += gap + visibleWidth(description);
				}
			}
			if (tag) line += " ".repeat(Math.max(2, width - used - tagWidth + 1)) + tag;
			lines.push(line);
			if (item.description && twoLine) {
				const description = truncateToWidth(item.description.replace(/\s+/g, " "), Math.max(1, width - indent - 1));
				lines.push(" ".repeat(indent) + this.style.muted(description));
			}
		}
		if (end < visible.length) lines.push(`  ${this.style.dim(`↓ ${visible.length - end} more`)}`);
		return lines;
	}

	private rowParts(
		item: SelectorItem<T>,
		index: number,
		isSelected: boolean,
		numbered: boolean,
		numberWidth: number,
		hasMarks: boolean,
		multi: boolean,
	): { lead: string; label: (text: string) => string } {
		const cursor = isSelected ? this.style.accent(this.style.bold("❯ ")) : "  ";
		const number = numbered ? this.style.dim(`${index + 1}.`.padEnd(numberWidth)) : "";
		let mark = "";
		if (multi) {
			mark = this.state.isChecked(item.id) ? `${this.style.tone("success", "[✓]")} ` : this.style.dim("[ ] ");
		} else if (hasMarks) {
			mark =
				item.mark === "on"
					? `${this.style.tone(isSelected ? "accent" : "success", "●")} `
					: item.mark === "off"
						? `${this.style.dim("○")} `
						: "  ";
		}
		const label = (text: string): string => {
			if (item.disabled) return this.style.dim(text);
			if (isSelected) return this.style.accent(this.style.bold(text));
			return this.style.text(text);
		};
		return { lead: ` ${cursor}${number}${mark}`, label };
	}
}

function isCtrlC(data: string): boolean {
	return data === "\x03";
}
