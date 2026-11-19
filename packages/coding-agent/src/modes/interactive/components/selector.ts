import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	sliceByColumn,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { getGlobalTheme } from "../theme/global-theme.ts";
import { theme } from "../theme/theme.js";
import {
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navActionText,
	navFirstKeyText,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "./nav-keys.ts";

/** A status colour a row's tag or notice can carry. */
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
	 * A mark before the label. A radio mark (`on` draws `●`, `off` draws `○`) shows the one current value, as in the
	 * model or theme picker; a checkbox mark (`checked` draws `[✓]`, `unchecked` draws `[ ]`) shows a row that is
	 * switched on, where enter switches it. Rows without a mark draw none.
	 */
	readonly mark?: "on" | "off" | "checked" | "unchecked";
	/** Paints the (possibly truncated) label instead of the default colours, told whether the row is selected. */
	readonly labelStyle?: (label: string, selected: boolean) => string;
	/** Rows that cannot be chosen: drawn dim, skipped by ↑↓, refused by enter. */
	readonly disabled?: boolean;
	/** Rows with the same group are listed under a section label. Items should already be ordered by group. */
	readonly group?: string;
	/** Extra text type-to-search matches against, beside the label, description and tag. */
	readonly searchText?: string;
	readonly searchTextMode?: "extend" | "replace";
}

/** A key a particular picker adds, such as ←→ for the reasoning effort in the model picker. */
export interface SelectorExtraKey<T> {
	/** Hint entry. When `matches` is omitted, `hint.action` decides whether a key press triggers this key. */
	readonly hint: NavKey;
	/** Whether the key does something for this row; a key that does nothing is left out of the hint. */
	readonly enabled?: (item: SelectorItem<T> | undefined) => boolean;
	/** Raw key matcher for keys that are not keybinding actions. */
	readonly matches?: (data: string) => boolean;
	readonly run: (item: SelectorItem<T> | undefined) => void;
}

export interface SelectorOptions<T> {
	readonly title?: string;
	/** Dim text under the title; each `\n` starts a line and long lines wrap. */
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
	/** Number the rows `1.` `2.`; digits 1–9 choose or toggle a row when there is no search box. */
	readonly numbered?: boolean;
	readonly wrap?: boolean;
	/** The row selected first. Defaults to the first row marked `on`, else the first enabled row. */
	readonly initialId?: string;
	/** Rows checked first in a multi-select. */
	readonly initialChecked?: readonly string[];
	/** Hint label for enter. Default `choose` (single) or `confirm` (multi). */
	readonly confirmLabel?: string | ((item: SelectorItem<T>) => string | undefined);
	readonly spaceConfirms?: boolean;
	readonly rightConfirms?: boolean;
	readonly minDescriptionWidth?: number;
	readonly selectedDetail?: (item: SelectorItem<T>) => string | undefined;
	/** Hint label for esc when the search is empty. Default `cancel`. */
	readonly cancelLabel?: string;
	/** Space opens a preview of the selected row; the hint shows `space <previewLabel>`. */
	readonly onPreview?: (item: SelectorItem<T>) => void;
	readonly previewLabel?: string;
	readonly extraKeys?: readonly SelectorExtraKey<T>[];
	/** Single-select: the chosen row. */
	readonly onSelect?: (item: SelectorItem<T>) => void;
	readonly closeOnSelect?: boolean;
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
const MIN_DESCRIPTION_LABEL_WIDTH = 8;
const DESCRIPTION_GAP = 2;
const MAX_DESCRIPTION_LABEL_WIDTH = 54;
const MIN_LABEL_WITH_DESCRIPTION_WIDTH = 24;

/** Filtering, selection and checked state of a picker, without rendering. */
export class SelectorState<T> {
	private _items: readonly SelectorItem<T>[];
	readonly mode: "single" | "multi";
	private _maxVisible: number;
	private query = "";
	private visible: readonly SelectorItem<T>[];
	private selected = 0;
	private top = 0;
	private readonly checked = new Set<string>();
	private revision = 0;
	private searchTexts = new WeakMap<SelectorItem<T>, string>();
	private visibleStats?: {
		items: readonly SelectorItem<T>[];
		stats: Readonly<{ enabledCount: number; hasRadioMarks: boolean }>;
	};

	constructor(options: Pick<SelectorOptions<T>, "items" | "mode" | "maxVisible" | "initialId" | "initialChecked">) {
		this._items = Object.freeze([...options.items]);
		this.mode = options.mode ?? "single";
		const maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;
		this._maxVisible = Number.isFinite(maxVisible) ? Math.max(1, Math.floor(maxVisible)) : DEFAULT_MAX_VISIBLE;
		this.visible = Object.freeze([...this.items]);
		for (const id of options.initialChecked ?? []) this.checked.add(id);
		const initial =
			options.initialId !== undefined
				? this.visible.findIndex((item) => item.id === options.initialId && !item.disabled)
				: -1;
		const marked = this.visible.findIndex((item) => item.mark === "on" && !item.disabled);
		this.selected = initial >= 0 ? initial : marked >= 0 ? marked : this.firstEnabled(0, 1);
		this.scrollToSelected();
	}

	get items(): readonly SelectorItem<T>[] {
		return this._items;
	}

	get maxVisible(): number {
		return this._maxVisible;
	}

	setMaxVisible(maxVisible: number): void {
		if (!Number.isFinite(maxVisible)) return;
		const next = Math.max(1, Math.floor(maxVisible));
		if (next === this._maxVisible) return;
		this._maxVisible = next;
		this.revision++;
		this.scrollToSelected();
	}

	getRevision(): number {
		return this.revision;
	}

	getQuery(): string {
		return this.query;
	}

	/** Rows that match the search, in list order (best match first while searching). */
	getVisible(): readonly SelectorItem<T>[] {
		return this.visible;
	}

	getVisibleStats(): Readonly<{ enabledCount: number; hasRadioMarks: boolean }> {
		if (this.visibleStats?.items === this.visible) return this.visibleStats.stats;
		let enabledCount = 0;
		let hasRadioMarks = false;
		for (const item of this.visible) {
			if (!item.disabled) enabledCount++;
			if (item.mark === "on" || item.mark === "off") hasRadioMarks = true;
		}
		const stats = Object.freeze({ enabledCount, hasRadioMarks });
		this.visibleStats = { items: this.visible, stats };
		return stats;
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

	/**
	 * Replace the rows, as after a catalog refresh or a row's text changing. The search is reapplied, and the row with
	 * the same id stays selected (or `preferId`, when given and listed).
	 */
	setItems(items: readonly SelectorItem<T>[], preferId?: string): void {
		this.revision++;
		this.searchTexts = new WeakMap();
		const browsed = this.visible[this.selected]?.id;
		const position = this.selected;
		this._items = Object.freeze([...items]);
		const ids = new Set(items.map((item) => item.id));
		for (const id of this.checked) if (!ids.has(id)) this.checked.delete(id);
		this.visible = Object.freeze(this.query ? this.filter(this.query) : [...this.items]);
		const find = (id: string | undefined) =>
			id === undefined ? -1 : this.visible.findIndex((item) => item.id === id && !item.disabled);
		const browsedIndex = find(browsed);
		const preferIndex = find(preferId);
		const index = browsedIndex >= 0 ? browsedIndex : preferIndex;
		this.selected =
			index >= 0 ? index : this.firstEnabled(Math.max(0, Math.min(position, this.visible.length - 1)), 1);
		this.scrollToSelected();
	}

	setQuery(query: string): void {
		if (query === this.query) return;
		this.revision++;
		const previous = this.visible[this.selected]?.id;
		this.query = query;
		this.visible = Object.freeze(query ? this.filter(query) : [...this.items]);
		const kept =
			previous === undefined ? -1 : this.visible.findIndex((item) => item.id === previous && !item.disabled);
		this.selected = query ? this.firstEnabled(0, 1) : kept >= 0 ? kept : this.firstEnabled(0, 1);
		this.top = 0;
		this.scrollToSelected();
	}

	move(delta: number, wrap = true): void {
		if (!Number.isInteger(delta) || delta === 0) return;
		const count = this.visible.length;
		if (count === 0) return;
		this.revision++;
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
		this.revision++;
		const target = Math.max(0, Math.min(this.visible.length - 1, this.selected + direction * this.maxVisible));
		this.selected = this.firstEnabled(target, direction === 1 ? -1 : 1);
		this.scrollToSelected();
	}

	/** Jump to the first or last enabled row. */
	edge(end: "first" | "last"): void {
		if (this.visible.length === 0) return;
		this.revision++;
		this.selected = end === "first" ? this.firstEnabled(0, 1) : this.firstEnabled(this.visible.length - 1, -1);
		this.scrollToSelected();
	}

	restoreSelection(previous: SelectorState<T>): void {
		const id = previous.getSelected()?.id;
		const index = this.visible.findIndex((item) => item.id === id && !item.disabled);
		if (index < 0) return;
		if (
			this.visible.length === previous.visible.length &&
			this.visible.every((item, i) => item.id === previous.visible[i]?.id)
		) {
			this.top = previous.getTop();
		}
		this.select(index);
	}

	select(index: number): void {
		if (!Number.isInteger(index) || index < 0 || index >= this.visible.length || this.visible[index]?.disabled)
			return;
		this.revision++;
		this.selected = index;
		this.scrollToSelected();
	}

	toggle(id: string): void {
		this.revision++;
		if (this.checked.has(id)) this.checked.delete(id);
		else this.checked.add(id);
	}

	private filter(query: string): SelectorItem<T>[] {
		return fuzzyFilter([...this.items], query, (item) => {
			let text = this.searchTexts.get(item);
			if (text === undefined) {
				text =
					item.searchTextMode === "replace"
						? (item.searchText ?? "")
						: [item.label, item.description ?? "", item.tag ?? "", item.searchText ?? ""].join(" ");
				this.searchTexts.set(item, text);
			}
			return text;
		});
	}

	private firstEnabled(from: number, direction: 1 | -1): number {
		for (let index = from; index >= 0 && index < this.visible.length; index += direction) {
			if (!this.visible[index]?.disabled) return index;
		}
		for (let index = from - direction; index >= 0 && index < this.visible.length; index -= direction) {
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
		| "spaceConfirms"
		| "cancelLabel"
		| "onPreview"
		| "previewLabel"
		| "extraKeys"
		| "keybindings"
	>,
): SelectorHintEntry[] {
	const keybindings = options.keybindings ?? getKeybindings();
	const selected = state.getSelected();
	const { enabledCount } = state.getVisibleStats();
	const multi = state.mode === "multi";
	const entries: SelectorHintEntry[] = [];
	if (enabledCount > 1) {
		const up = navActionText(keybindings, "tui.select.up");
		const down = navActionText(keybindings, "tui.select.down");
		const keys = up === "↑" && down === "↓" ? "↑↓" : [up, down].filter(Boolean).join("/");
		if (keys) entries.push(tagHintEntry({ keys, label: "select" }, "select"));
	}
	if (multi && selected) entries.push({ keys: "space", label: "toggle" });
	if (!multi && selected && options.onPreview)
		entries.push(tagHintEntry({ keys: "space", label: options.previewLabel ?? "preview" }, "preview"));
	const confirmLabel =
		typeof options.confirmLabel === "function"
			? selected && options.confirmLabel(selected)
			: (options.confirmLabel ?? (multi ? "confirm" : "choose"));
	if (confirmLabel && (multi ? state.getChecked().length > 0 || selected !== undefined : selected)) {
		const spaceToo = options.spaceConfirms === true && !multi && !state.getQuery();
		const enter = navActionText(keybindings, "tui.select.confirm");
		entries.push(
			spaceToo && enter
				? { keys: `${enter}/space`, label: confirmLabel, role: "confirm" }
				: { action: "tui.select.confirm", label: confirmLabel, role: "confirm" },
		);
	}
	for (const extra of options.extraKeys ?? []) {
		if (extra.enabled?.(selected) ?? true) entries.push({ ...extra.hint, role: "extra" });
	}
	if (options.search) entries.push(tagHintEntry({ keys: "type", label: "to search" }, "to search"));
	else if (options.numbered && enabledCount > 0) {
		const keys = numberedHintKeys(state.getVisible());
		if (keys) entries.push(tagHintEntry({ keys, label: "pick" }, "pick"));
	}
	const cancel = navFirstKeyText(keybindings, "tui.select.cancel") || "esc";
	entries.push({
		keys: cancel,
		label: state.getQuery() ? "clear" : (options.cancelLabel ?? "cancel"),
		role: "cancel",
	});
	if (!options.search) {
		const help = navActionText(keybindings, "app.keys.help");
		if (help) entries.push(tagHintEntry({ action: "app.keys.help", label: "keys" }, "keys"));
	}
	return entries;
}

const HINT_DROP_ORDER = ["to search", "keys", "pick", "preview", "select"] as const;
type HintDropKey = (typeof HINT_DROP_ORDER)[number];
const hintDropKeys = new WeakMap<SelectorHintEntry, HintDropKey>();

function tagHintEntry(entry: SelectorHintEntry, key: HintDropKey): SelectorHintEntry {
	hintDropKeys.set(entry, key);
	return entry;
}

export interface SelectorHintEntry extends NavKey {
	readonly role?: "confirm" | "cancel" | "extra";
}

export function fitHintEntries(
	entries: readonly SelectorHintEntry[],
	room: number,
	keybindings: NavKeybindings,
): SelectorHintEntry[] {
	const text = (entry: NavKey) =>
		`${entry.action !== undefined ? navActionText(keybindings, entry.action) : (entry.keys ?? "")} ${entry.label}`;
	const kept = [...entries];
	const width = () => visibleWidth(kept.map(text).join(" · "));
	const essential = (entry: SelectorHintEntry) =>
		entry.role !== "extra" &&
		(entry.role === "confirm" || entry.role === "cancel" || entry.action === "tui.select.confirm");
	const dropKey = (entry: SelectorHintEntry): HintDropKey | undefined =>
		essential(entry) || entry.role === "extra"
			? undefined
			: (hintDropKeys.get(entry) ?? HINT_DROP_ORDER.find((key) => key === entry.label));
	while (kept.length > 1 && width() > room) {
		const byOrder = HINT_DROP_ORDER.map((key) => kept.findIndex((entry) => dropKey(entry) === key)).find(
			(index) => index >= 0,
		);
		const other = kept.findLastIndex((entry) => !essential(entry) && dropKey(entry) === undefined);
		const nonEssential = kept.findIndex((entry) => !essential(entry));
		const drop =
			byOrder ??
			(other >= 0 ? other : nonEssential >= 0 ? nonEssential : kept.findIndex((entry) => entry.role !== "cancel"));
		if (drop < 0) break;
		kept.splice(drop, 1);
	}
	return kept;
}

function numberedHintKeys<T>(visible: readonly SelectorItem<T>[]): string {
	const limit = Math.min(9, visible.length);
	const ranges: string[] = [];
	let start = 0;
	for (let index = 0; index < limit; index++) {
		if (!visible[index]?.disabled) {
			if (start === 0) start = index + 1;
		} else if (start !== 0) {
			ranges.push(start === index ? `${start}` : `${start}-${index}`);
			start = 0;
		}
	}
	if (start !== 0) {
		ranges.push(start === limit ? `${start}` : `${start}-${limit}`);
	}
	return ranges.join("/");
}

function clipSelectorLine(line: string, width: number): string {
	let clipped = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
	let room = width;
	while (visibleWidth(clipped) > width && room > 0) {
		room = Math.max(0, room - Math.max(1, visibleWidth(clipped) - width));
		clipped = sliceByColumn(clipped, 0, room, true);
	}
	return clipped;
}

/** The picker component: state, rendering and keys. */
export class Selector<T> implements Component, Focusable {
	readonly capturesViewportInput = true;
	readonly state: SelectorState<T>;
	private readonly options: SelectorOptions<T>;
	private readonly style: SelectorStyle;
	private input?: Input;
	private showingHelp = false;
	private title?: string;
	private subtitle?: string;
	private notice?: { text: string; tone: SelectorTone };
	private rowLines = new Map<number, string>();
	private mousePressed?: string;
	private closed = false;
	private selectedId?: string;
	private _focused = false;
	private cachedRender?: {
		width: number;
		revision: number;
		theme: ReturnType<typeof getGlobalTheme>;
		keybindings: NavKeybindings;
		bindingKeys: string;
		inputValue?: string;
		inputCursor?: number;
		inputFocused?: boolean;
		rowLines: Map<number, string>;
		lines: string[];
	};

	constructor(options: SelectorOptions<T>) {
		this.options = options;
		this.title = options.title;
		this.subtitle = options.subtitle;
		this.style = options.style ?? themeSelectorStyle();
		this.state = new SelectorState(options);
		if (options.search) {
			this.input = this.createInput();
			if (options.initialQuery) {
				this.input.setValue(options.initialQuery);
				this.state.setQuery(options.initialQuery);
			}
		}
		this.selectedId = this.state.getSelected()?.id;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		if (value !== this._focused) this.cachedRender = undefined;
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	private createInput(): Input {
		const input = new Input({
			prompt: "⌕ ",
			placeholder: this.options.searchPlaceholder ?? "Search…",
			placeholderStyle: (text) => this.style.dim(text),
		});
		input.focused = this._focused;
		return input;
	}

	/** The search box, when the picker has one. */
	getSearchInput(): Input | undefined {
		return this.input;
	}

	/** Empty the search with a fresh search box, so its undo and kill history cannot bring the old text back. */
	clearSearch(): void {
		if (!this.input) return;
		this.cachedRender = undefined;
		this.input = this.createInput();
		this.state.setQuery("");
		this.notifySelectionChange();
	}

	setTitle(title: string | undefined): void {
		this.cachedRender = undefined;
		this.title = title;
	}

	/** The dim line under the title; `undefined` removes it. */
	setSubtitle(subtitle: string | undefined): void {
		this.cachedRender = undefined;
		this.subtitle = subtitle;
	}

	/** A one-line message under the list, such as a refresh status or an error; `undefined` clears it. */
	setNotice(notice: { text: string; tone: SelectorTone } | undefined): void {
		this.cachedRender = undefined;
		this.notice = notice;
	}

	getSelected(): SelectorItem<T> | undefined {
		return this.state.getSelected();
	}

	retrySelection(): void {
		this.closed = false;
	}

	/** Replace the rows, keeping the search and the selected row; see {@link SelectorState.setItems}. */
	setItems(items: readonly SelectorItem<T>[], preferId?: string): void {
		this.cachedRender = undefined;
		const searchEnabled = Boolean(this.options.search);
		if (Boolean(this.input) !== searchEnabled) {
			if (searchEnabled) {
				this.showingHelp = false;
				this.input = this.createInput();
			} else {
				this.input = undefined;
				this.state.setItems(items, preferId);
				this.state.setQuery("");
				this.notifySelectionChange();
				return;
			}
		}
		this.state.setItems(items, preferId);
		this.notifySelectionChange();
	}

	/** Carry navigation, not the old rows or their callbacks, into a refreshed picker. */
	restoreNavigation(previous: Selector<T>, keepHighlight: boolean): void {
		if (this.input && previous.input) {
			this.input = previous.input;
			this.state.setQuery(this.input.getValue());
		}
		if (keepHighlight || this.state.getQuery()) this.state.restoreSelection(previous.state);
		this.showingHelp = previous.showingHelp;
		this.mousePressed = previous.mousePressed;
		this.focused = previous.focused;
		// Reapply a user's preview even if that row is also the new configured default.
		if (keepHighlight) this.selectedId = undefined;
		this.notifySelectionChange();
	}

	/** Set the search text as if typed. */
	setQuery(query: string): void {
		this.cachedRender = undefined;
		this.input?.setValue(query);
		this.state.setQuery(query);
		this.notifySelectionChange();
	}

	invalidate(): void {
		this.cachedRender = undefined;
		this.input?.invalidate();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.cachedRender = undefined;
		const kb = this.options.keybindings ?? getKeybindings();
		if (this.showingHelp) {
			if (matchesKey(data, "ctrl+c")) {
				this.showingHelp = false;
				this.closed = true;
				this.mousePressed = undefined;
				this.options.onCancel?.();
			} else if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.keys.help")) {
				this.showingHelp = false;
			}
			return;
		}
		const selected = this.state.getSelected();
		if (kb.matches(data, "tui.select.up") || (!this.input && data === "k")) this.state.move(-1);
		else if (kb.matches(data, "tui.select.down") || (!this.input && data === "j")) this.state.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.state.page(-1);
		else if (kb.matches(data, "tui.select.pageDown")) this.state.page(1);
		else if (!this.input && matchesKey(data, "home")) this.state.edge("first");
		else if (!this.input && matchesKey(data, "end")) this.state.edge("last");
		else if (kb.matches(data, "tui.select.cancel")) {
			if (this.state.getQuery() && !matchesKey(data, "ctrl+c")) this.clearSearch();
			else {
				this.closed = true;
				this.mousePressed = undefined;
				this.options.onCancel?.();
			}
			return;
		} else if (this.runExtraKey(kb, data, selected)) {
			this.notifySelectionChange();
			return;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(this.options.rightConfirms !== false && kb.matches(data, "app.list.open") && !this.state.getQuery())
		) {
			this.confirm();
			return;
		} else if (
			data === " " &&
			this.options.spaceConfirms === true &&
			this.state.mode === "single" &&
			!this.state.getQuery()
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
			this.mousePressed = undefined;
			return;
		} else if (!this.input && this.options.numbered && /^[1-9]$/.test(data)) {
			this.pickNumber(Number(data) - 1);
			return;
		} else if (this.input) {
			this.input.handleInput(data);
			this.state.setQuery(this.input.getValue());
		} else return;
		this.notifySelectionChange();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || this.showingHelp) return { handled: true };
		if (event.type === "wheel" && event.wheelDelta) {
			const before = this.state.getSelected()?.id;
			this.state.move(event.wheelDelta < 0 ? -1 : 1, false);
			this.notifySelectionChange();
			return { handled: true, render: this.state.getSelected()?.id !== before };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const id = this.rowLines.get(event.y);
		if (id === undefined) {
			this.mousePressed = undefined;
			return undefined;
		}
		const visible = this.state.getVisible();
		const index = visible.findIndex((entry) => entry.id === id);
		const item = index < 0 ? undefined : visible[index];
		if (!item || item.disabled) {
			this.mousePressed = undefined;
			return { handled: true };
		}
		if (event.type === "press") {
			this.mousePressed = item.id;
			this.state.select(index);
			this.notifySelectionChange();
			return { handled: true, focus: true };
		}
		const pressed = this.mousePressed;
		this.mousePressed = undefined;
		if (pressed !== item.id) return { handled: true };
		this.state.select(index);
		this.notifySelectionChange();
		if (this.state.mode === "multi") this.state.toggle(item.id);
		else this.confirm();
		return { handled: true };
	}

	render(width: number): string[] {
		const keybindings = this.options.keybindings ?? getKeybindings();
		const revision = this.state.getRevision();
		const activeTheme = getGlobalTheme();
		const inputValue = this.input?.getValue();
		const inputCursor = this.input?.getCursor();
		const inputFocused = this.input?.focused;
		const bindingKeys = [
			"tui.select.up",
			"tui.select.down",
			"tui.select.confirm",
			"tui.select.cancel",
			"app.keys.help",
			...(this.options.extraKeys ?? []).flatMap((extra) => (extra.hint.action ? [extra.hint.action] : [])),
		]
			.map((action) => keybindings.getKeys?.(action)?.join(",") ?? "")
			.join("\0");
		const visible = this.state.getVisible();
		const hasCustomLabels = visible
			.slice(this.state.getTop(), this.state.getTop() + this.state.maxVisible)
			.some((item) => item.labelStyle !== undefined);
		const cached = hasCustomLabels ? undefined : this.cachedRender;
		if (
			cached?.width === width &&
			cached.revision === revision &&
			cached.theme === activeTheme &&
			cached.keybindings === keybindings &&
			cached.bindingKeys === bindingKeys &&
			cached.inputValue === inputValue &&
			cached.inputCursor === inputCursor &&
			cached.inputFocused === inputFocused
		) {
			this.rowLines = cached.rowLines;
			return cached.lines;
		}
		if (this.showingHelp) {
			this.rowLines.clear();
			const title = this.options.helpTitle ?? this.title ?? "keys";
			return renderNavKeyOverlay(
				title,
				this.helpEntries(),
				width,
				this.style,
				this.options.keybindings ?? getKeybindings(),
				"tui.select.cancel",
			).map((line) => clipSelectorLine(line, width));
		}
		const lines: string[] = [];
		const inner = Math.max(1, width - 2);
		if (this.title) {
			if (this.options.wrap) {
				for (const wrapped of wrapTextWithAnsi(this.title, inner)) {
					lines.push(`  ${this.style.bold(this.style.text(wrapped))}`);
				}
			} else {
				lines.push(`  ${this.style.bold(this.style.text(truncateToWidth(this.title, Math.max(1, inner - 1))))}`);
			}
		}
		for (const line of (this.subtitle ?? "").split("\n")) {
			if (!this.subtitle) break;
			for (const wrapped of wrapTextWithAnsi(line, inner)) lines.push(`  ${this.style.muted(wrapped)}`);
		}
		if (this.input) lines.push(...this.renderSearch(width));
		if (lines.length > 0) lines.push("");
		this.rowLines = new Map();
		lines.push(...this.renderRows(width, lines.length));
		const selectedItem = this.state.getSelected();
		const detail = selectedItem ? this.options.selectedDetail?.(selectedItem) : undefined;
		if (detail) {
			lines.push("");
			for (const wrapped of wrapTextWithAnsi(detail, Math.max(1, inner - 2)))
				lines.push(`  ${this.style.muted(wrapped)}`);
		}
		if (this.notice) {
			lines.push("");
			lines.push(`  ${this.style.tone(this.notice.tone, truncateToWidth(this.notice.text, inner))}`);
		}
		lines.push("");
		lines.push(
			renderNavHintLine(
				fitHintEntries(
					selectorHintEntries(this.state, { ...this.options, search: Boolean(this.input) }),
					width - 2,
					keybindings,
				),
				width,
				this.style,
				keybindings,
			),
		);
		const rendered = lines.map((line) => clipSelectorLine(line, width));
		this.cachedRender = {
			width,
			revision,
			theme: activeTheme,
			keybindings,
			bindingKeys,
			inputValue,
			inputCursor,
			inputFocused,
			rowLines: new Map(this.rowLines),
			lines: rendered,
		};
		return rendered;
	}

	private helpEntries(): NavKey[] {
		const entries = selectorHintEntries(this.state, { ...this.options, search: Boolean(this.input) }).filter(
			(entry) => entry.action !== "app.keys.help",
		);
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

	private notifySelectionChange(): void {
		const item = this.state.getSelected();
		if (item?.id === this.selectedId) return;
		this.selectedId = item?.id;
		this.options.onSelectionChange?.(item);
	}

	private confirm(): void {
		if (this.closed) return;
		if (this.state.mode === "multi") {
			if (this.state.getChecked().length === 0 && !this.state.getSelected()) return;
			this.closed = true;
			this.mousePressed = undefined;
			this.options.onConfirm?.(this.state.getChecked());
			return;
		}
		const item = this.state.getSelected();
		if (!item) return;
		if (this.options.closeOnSelect !== false) this.closed = true;
		this.mousePressed = undefined;
		this.options.onSelect?.(item);
	}

	private pickNumber(index: number): void {
		const item = this.state.getVisible()[index];
		if (!item || item.disabled) return;
		this.state.select(index);
		this.notifySelectionChange();
		if (this.state.mode === "multi") this.state.toggle(item.id);
		else this.confirm();
	}

	private renderSearch(width: number): string[] {
		const boxWidth = Math.max(8, width - 2);
		const field = Math.max(1, boxWidth - 4);
		const content = this.input?.render(field)[0] ?? "";
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
		const hasMarks = this.state.getVisibleStats().hasRadioMarks;
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
			const parts = this.rowParts(item, index, isSelected, numbered, numberWidth, hasMarks, multi);
			const indent = visibleWidth(parts.lead);
			const requestedMinDesc = this.options.minDescriptionWidth;
			const minDesc =
				!twoLine && item.description && requestedMinDesc !== undefined && Number.isFinite(requestedMinDesc)
					? Math.max(1, Math.floor(requestedMinDesc))
					: undefined;
			const reservedDesc =
				minDesc !== undefined && width - indent - 1 - DESCRIPTION_GAP - minDesc >= MIN_DESCRIPTION_LABEL_WIDTH
					? DESCRIPTION_GAP + minDesc
					: 0;
			const rawTagWidth = item.tag ? visibleWidth(item.tag) : 0;
			const reservedTag =
				reservedDesc > 0 && rawTagWidth > 0
					? Math.min(rawTagWidth + 2, Math.max(0, width - indent - 1 - reservedDesc - MIN_DESCRIPTION_LABEL_WIDTH))
					: 0;
			const labelRoom = Math.max(1, width - indent - 1 - reservedDesc - reservedTag);
			const wrappedLabels = this.options.wrap ? wrapTextWithAnsi(item.label, labelRoom) : undefined;
			const label = wrappedLabels
				? (wrappedLabels[0] ?? "")
				: visibleWidth(item.label) > labelRoom
					? truncateToWidth(item.label, labelRoom)
					: item.label;
			const tagRoom = Math.max(0, width - indent - visibleWidth(label) - 3 - reservedDesc);
			const tagText =
				item.tag && rawTagWidth > 0
					? rawTagWidth <= tagRoom
						? item.tag
						: tagRoom >= 4 && visibleWidth(truncateToWidth(item.tag, tagRoom - 3, "")) > 0
							? truncateToWidth(item.tag, tagRoom)
							: ""
					: "";
			const tag = tagText ? this.style.tone(item.tagTone ?? "muted", tagText) : "";
			const tagWidth = tagText ? visibleWidth(tagText) + 2 : 0;
			const room = Math.max(1, width - indent - tagWidth - 1);
			let effectiveLabel = label;
			let line = parts.lead + parts.label(effectiveLabel);
			let used = indent + visibleWidth(effectiveLabel);
			if (item.description && !twoLine) {
				const text = item.description.replace(/\s+/g, " ").trim();
				const descWidth = visibleWidth(text);
				if (descWidth > 0) {
					const minDescWidth = minDesc ?? Math.min(MIN_DESCRIPTION_WIDTH, descWidth);
					const maxPrimary = Math.min(MAX_DESCRIPTION_LABEL_WIDTH, room - DESCRIPTION_GAP - minDescWidth);
					const reserveDesc = Math.max(minDescWidth, Math.min(descWidth, room - DESCRIPTION_GAP - maxPrimary));
					const descLabelRoom = room - DESCRIPTION_GAP - reserveDesc;
					if (
						!wrappedLabels &&
						descLabelRoom >= MIN_LABEL_WITH_DESCRIPTION_WIDTH &&
						visibleWidth(effectiveLabel) > descLabelRoom
					) {
						effectiveLabel = truncateToWidth(effectiveLabel, descLabelRoom);
						line = parts.lead + parts.label(effectiveLabel);
						used = indent + visibleWidth(effectiveLabel);
					}
					const column = Math.min(labelWidth, Math.max(visibleWidth(effectiveLabel), descLabelRoom));
					const gap = column - visibleWidth(effectiveLabel) + DESCRIPTION_GAP;
					const descRoom = width - used - gap - tagWidth - 1;
					if (descRoom >= (minDesc ?? MIN_DESCRIPTION_WIDTH)) {
						const description = descWidth > descRoom ? truncateToWidth(text, descRoom) : text;
						line += " ".repeat(gap) + this.style.muted(description);
						used += gap + visibleWidth(description);
					}
				}
			}
			if (tag) line += " ".repeat(Math.max(2, width - used - tagWidth + 1)) + tag;
			this.rowLines.set(firstLine + lines.length, item.id);
			lines.push(line);
			if (wrappedLabels && wrappedLabels.length > 1) {
				for (const continuation of wrappedLabels.slice(1)) {
					this.rowLines.set(firstLine + lines.length, item.id);
					lines.push(" ".repeat(indent) + parts.label(continuation));
				}
			}
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
		} else if (item.mark === "checked" || item.mark === "unchecked") {
			mark = item.mark === "checked" ? `${this.style.tone("success", "[✓]")} ` : this.style.dim("[ ] ");
		} else if (hasMarks) {
			mark =
				item.mark === "on"
					? `${this.style.tone(isSelected ? "accent" : "success", "●")} `
					: item.mark === "off"
						? `${this.style.dim("○")} `
						: "  ";
		}
		const label = (text: string): string => {
			if (item.labelStyle) return item.labelStyle(text, isSelected);
			if (item.disabled) return this.style.dim(text);
			if (isSelected) return this.style.accent(this.style.bold(text));
			return this.style.text(text);
		};
		return { lead: ` ${cursor}${number}${mark}`, label };
	}
}

export class FramedSelector<T> implements Component, Focusable {
	readonly capturesViewportInput = true;
	readonly selector: Selector<T>;
	private readonly rule: (width: number) => string;

	constructor(options: SelectorOptions<T>) {
		this.selector = new Selector(options);
		const style = options.style ?? themeSelectorStyle();
		this.rule = (width) => style.border("─".repeat(Math.max(1, width)));
	}

	get focused(): boolean {
		return this.selector.focused;
	}
	set focused(value: boolean) {
		this.selector.focused = value;
	}

	render(width: number): string[] {
		return [this.rule(width), ...this.selector.render(width), this.rule(width)];
	}

	handleInput(data: string): void {
		this.selector.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.selector.handleMouse({ ...event, y: event.y - 1 });
	}

	invalidate(): void {
		this.selector.invalidate();
	}
}
