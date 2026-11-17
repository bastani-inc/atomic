import type { Component, Focusable, SettingItem, TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import { Selector, type SelectorItem } from "./selector.ts";

export interface SettingsPickerOptions {
	/** Title over the search box; no title when absent. */
	readonly title?: string;
	/** Dim lines under the title. */
	readonly subtitle?: string;
	/** A search box filters the settings by label. */
	readonly search?: boolean;
	readonly maxVisible?: number;
}

/**
 * The settings list on the shared picker: a value column beside each label (`›` after a value that opens its own
 * picker), the selected setting's description under the list, and one hint line. Enter or space changes the selected
 * setting: it steps an enumerated value in place or opens its picker, which replaces the list until it is done.
 */
export class SettingsPicker implements Component, Focusable {
	readonly capturesViewportInput = true;
	private readonly items: SettingItem[];
	private readonly onChange: (id: string, newValue: string) => void;
	private readonly selector: Selector<SettingItem>;
	private submenu: Component | null = null;
	private submenuItemId: string | null = null;
	private navigateAfterClose: string | null = null;
	private _focused = false;

	constructor(
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsPickerOptions = {},
	) {
		this.items = items;
		this.onChange = onChange;
		this.selector = new Selector<SettingItem>({
			...(options.title ? { title: options.title } : {}),
			...(options.subtitle ? { subtitle: options.subtitle } : {}),
			items: this.selectorItems(),
			search: options.search === true,
			searchPlaceholder: "Search settings…",
			maxVisible: options.maxVisible ?? 10,
			emptyText: "No settings available",
			closeOnSelect: false,
			spaceConfirms: true,
			confirmLabel: (item) => (item.value.submenu ? "open" : item.value.values?.length ? "change" : undefined),
			selectedDetail: (item) => item.value.description,
			onSelect: (item) => this.activate(item.value),
			onCancel,
		});
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
		if (this.submenu && "focused" in this.submenu) (this.submenu as Component & Focusable).focused = value;
	}

	/** Update an item's shown value, as after a change made elsewhere. */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((entry) => entry.id === id);
		if (!item) return;
		item.currentValue = newValue;
		this.refresh();
	}

	/** Move the selection to the setting with this id; a search that hides it is cleared first. */
	selectItem(id: string): void {
		const find = () => this.selector.state.getVisible().findIndex((item) => item.id === id);
		let index = find();
		if (index < 0 && this.selector.state.getQuery()) {
			this.selector.clearSearch();
			index = find();
		}
		if (index >= 0) this.selector.state.select(index);
	}

	invalidate(): void {
		this.selector.invalidate();
		this.submenu?.invalidate?.();
	}

	render(width: number): string[] {
		return this.submenu ? this.submenu.render(width) : this.selector.render(width);
	}

	handleInput(data: string): void {
		if (this.submenu) {
			this.submenu.handleInput?.(data);
			return;
		}
		this.selector.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenu) {
			const result = this.submenu.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}
		return this.selector.handleMouse(event);
	}

	private selectorItems(): SelectorItem<SettingItem>[] {
		return this.items.map((item) => ({
			id: item.id,
			value: item,
			label: item.label,
			description: item.submenu ? `${item.currentValue} ›` : item.currentValue,
			searchText: item.label,
			searchTextMode: "replace",
		}));
	}

	private refresh(): void {
		this.selector.setItems(this.selectorItems());
	}

	private activate(item: SettingItem): void {
		if (item.submenu) {
			this.submenuItemId = item.id;
			this.submenu = item.submenu(item.currentValue, (selectedValue, options) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				if (options?.navigateTo) this.navigateAfterClose = options.navigateTo;
				this.closeSubmenu();
			});
			if ("focused" in this.submenu) (this.submenu as Component & Focusable).focused = this._focused;
			return;
		}
		if (item.values && item.values.length > 0) {
			const next = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length]!;
			item.currentValue = next;
			this.onChange(item.id, next);
			this.refresh();
		}
	}

	private closeSubmenu(): void {
		this.submenu = null;
		this.refresh();
		const target = this.navigateAfterClose ?? this.submenuItemId;
		const reopen = this.navigateAfterClose !== null;
		this.navigateAfterClose = null;
		this.submenuItemId = null;
		if (target === null) return;
		this.selectItem(target);
		if (!reopen) return;
		const item = this.items.find((entry) => entry.id === target);
		if (item) this.activate(item);
	}
}
