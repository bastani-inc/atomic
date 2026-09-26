import type { Component, SelectItem, SelectListLayoutOptions, SettingItem } from "@earendil-works/pi-tui";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { WarningSettings } from "../../../core/settings-manager.ts";
import {
	createEmptyWebhooksDocument,
	readWebhooksFile,
	webhooksConfigPath,
	writeWebhooksFile,
} from "../../../extensions/webhooks/config.ts";
import type { WebhookDestinationType } from "../../../extensions/webhooks/constants.ts";
import { presetDestinationTemplate } from "../../../extensions/webhooks/presets.ts";
import type { WebhooksFileReadResult } from "../../../extensions/webhooks/types.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.js";
import type { SettingsCallbacks } from "./settings-selector-types.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const AUTOMATIC_THEME_VALUE = "/";

/**
 * A submenu component for selecting from a list of options.
 */
export class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): boolean {
		this.settingsList.handleInput(data);
		return true;
	}
}

export class SelectSubmenu extends Container {
	private selectList: SelectList;
	private readonly allOptions: SelectItem[];
	private readonly currentValue: string;
	private readonly onSelectValue: (value: string) => void;
	private readonly onCancelValue: () => void;
	private searchInput?: Input;
	private listChildIndex = 0;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		searchable = false,
	) {
		super();
		this.allOptions = options;
		this.currentValue = currentValue;
		this.onSelectValue = onSelect;
		this.onCancelValue = onCancel;

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		if (searchable) {
			this.addChild(new Spacer(1));
			this.searchInput = new Input();
			this.addChild(this.searchInput);
		}

		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.listChildIndex = this.children.length;
		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  enter select · esc back"), 0, 0));
	}

	handleInput(data: string): boolean {
		if (!this.searchInput) {
			this.selectList.handleInput(data);
			return true;
		}
		const kb = getKeybindings();
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm") ||
			kb.matches(data, "tui.select.cancel")
		) {
			this.selectList.handleInput(data);
			return true;
		}
		this.searchInput.handleInput(data);
		const query = this.searchInput.getValue();
		const options = query
			? fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allOptions;
		const list = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);
		const currentIndex = options.findIndex((item) => item.value === this.currentValue);
		// Searching should focus the best match, not a weaker match of the saved value.
		if (!query && currentIndex !== -1) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => this.onSelectValue(item.value);
		list.onCancel = this.onCancelValue;
		this.children[this.listChildIndex] = list;
		this.selectList = list;
		return true;
	}
}

export function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
	}));
}

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

export class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): boolean {
		if (!this.inputComponent?.handleInput) return false;
		this.inputComponent.handleInput(data);
		return true;
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * The `Webhooks` screen: inspect what is configured, turn each destination on or
 * off, and append a preset template.
 *
 * It edits `~/.atomic/agent/webhooks.json` through the extension's own reader and
 * writer rather than keeping any state of its own, because the issue requires
 * that the file stay authoritative and that settings toggles and preset setup
 * edit that same file instead of a second registry. Reaching into a built-in's
 * module for one helper follows `core/extensions/herdr-file-integration.ts`,
 * which imports Herdr's environment reader the same way.
 *
 * Three things it deliberately does not do, per the issue's out-of-scope list:
 * no URL prompt (a webhook URL is a bearer credential and templates leave a
 * placeholder for direct file entry), no per-field editor, and no delete.
 */
export class WebhooksSubmenu extends Container {
	private settingsList: SettingsList;
	private readonly path: string;
	/**
	 * The name each row was built from. A row identifies a destination by its
	 * position in the file, and the file can be edited by hand while this screen
	 * is open, so the name is what proves the entry at that position is still the
	 * one whose label the user is looking at.
	 */
	private readonly rowNames = new Map<string, string>();

	constructor(onCancel: () => void) {
		super();
		this.path = webhooksConfigPath();
		const read = readWebhooksFile(this.path);

		this.addChild(new Text(theme.bold(theme.fg("accent", "Webhooks")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Notifications for agent completion, errors and input requests, and for top-level workflows.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		// The resolved path, never an assumed home directory: the file is where
		// URLs and headers are entered, so the user has to be able to find it.
		this.addChild(new Text(theme.fg("muted", this.path), 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = read.kind === "current" || read.kind === "absent" ? this.editableItems(read) : [];

		if (items.length === 0 && read.kind !== "current" && read.kind !== "absent") {
			// A file that could not be parsed is shown, not silently replaced:
			// writing over it would discard whatever the user meant to write.
			this.addChild(
				new Text(theme.fg("error", `This file could not be used: ${describeUnusableWebhooksFile(read)}`), 0, 0),
			);
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Fix it in the file, then reopen this screen."), 0, 0));
		}

		this.settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 1), 10),
			getSettingsListTheme(),
			(id, newValue) => this.apply(id, newValue, onCancel),
			onCancel,
		);
		this.addChild(this.settingsList);
	}

	/** One row per configured destination, plus one row that appends a preset. */
	private editableItems(read: WebhooksFileReadResult): SettingItem[] {
		const destinations = read.kind === "current" ? read.destinations : [];
		const items: SettingItem[] = destinations.map((destination) => {
			this.rowNames.set(`destination:${destination.index}`, destination.name);
			return {
				id: `destination:${destination.index}`,
				label: destination.name,
				description: `${destination.type} · ${destination.events.length} event${destination.events.length === 1 ? "" : "s"}`,
				currentValue: destination.enabled ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
			};
		});
		items.push({
			id: "add",
			label: "Add a destination",
			description: "Appends a template with a placeholder URL, disabled until you fill it in",
			currentValue: destinations.length === 0 ? "none configured" : `${destinations.length} configured`,
			submenu: (_currentValue, done) =>
				new SelectSubmenu(
					"Add a destination",
					"The template is written to the file with a placeholder URL. Paste your own URL there, then enable it here.",
					[
						{ label: "Slack", value: "slack", description: "Incoming webhook" },
						{ label: "Microsoft Teams", value: "teams", description: "Workflows incoming webhook" },
						{ label: "Custom", value: "custom", description: "One JSON key per placeholder" },
					],
					"slack",
					(value) => {
						this.appendPreset(value as WebhookDestinationType);
						done(undefined, { navigateTo: "add" });
					},
					() => done(),
				),
		});
		return items;
	}

	/** Toggle one destination's `enabled`, leaving every other key in the file alone. */
	private apply(id: string, newValue: string, onCancel: () => void): void {
		if (!id.startsWith("destination:")) return;
		const index = Number.parseInt(id.slice("destination:".length), 10);
		const read = readWebhooksFile(this.path);
		if (read.kind !== "current") {
			// The file changed under us between opening this screen and this
			// keystroke. Closing is honest; writing would clobber the new contents.
			onCancel();
			return;
		}
		const entries = read.document.destinations;
		if (!Array.isArray(entries) || index < 0 || index >= entries.length) {
			onCancel();
			return;
		}
		const entry = entries[index];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			onCancel();
			return;
		}
		// Position alone is not identity. If the file was reordered or an entry was
		// removed while this screen was open, the row's label no longer describes
		// what sits at that position, and toggling it would change a destination
		// the user is not looking at.
		if (entry.name !== this.rowNames.get(id)) {
			onCancel();
			return;
		}
		// Keys are readonly, so an edit is a spread: everything this module does
		// not know about survives the round trip.
		const next = entries.map((value, position) =>
			position === index ? { ...entry, enabled: newValue === "enabled" } : value,
		);
		writeWebhooksFile({ ...read.document, destinations: next }, this.path);
		this.settingsList.updateValue(id, newValue);
	}

	/** Append a preset template to the file's `destinations`, keeping the rest intact. */
	private appendPreset(type: WebhookDestinationType): void {
		const read = readWebhooksFile(this.path);
		const document = read.kind === "current" ? read.document : createEmptyWebhooksDocument();
		if (read.kind !== "current" && read.kind !== "absent") return;
		const entries = Array.isArray(document.destinations) ? document.destinations : [];
		const label = type === "slack" ? "Slack" : type === "teams" ? "Microsoft Teams" : "Custom";
		const taken = new Set(
			entries.map((entry) =>
				entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string"
					? entry.name
					: "",
			),
		);
		let name = label;
		for (let suffix = 2; taken.has(name); suffix += 1) name = `${label} ${suffix}`;
		writeWebhooksFile({ ...document, destinations: [...entries, presetDestinationTemplate(type, name)] }, this.path);
	}

	handleInput(data: string): boolean {
		this.settingsList.handleInput(data);
		return true;
	}
}

/** Why a webhooks file cannot be edited from here, in words that never quote the file. */
function describeUnusableWebhooksFile(read: WebhooksFileReadResult): string {
	switch (read.kind) {
		case "unreadable":
			return `it could not be read (${read.code})`;
		case "malformed":
			return read.message;
		case "unsupported":
			return read.message;
		default:
			return "unknown reason";
	}
}
