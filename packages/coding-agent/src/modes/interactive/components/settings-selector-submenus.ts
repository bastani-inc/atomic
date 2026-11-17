import type {
	Component,
	Focusable,
	SelectItem,
	SettingItem,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { Container } from "@bastani/atomic-tui";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import type { WarningSettings } from "../../../core/settings-manager.ts";
import { parseAutoThemeSetting, type TerminalTheme } from "../theme/theme.js";
import { Selector, type SelectorItem } from "./selector.ts";
import { SettingsPicker } from "./settings-picker.ts";
import type { SettingsCallbacks } from "./settings-selector-types.ts";

const AUTOMATIC_THEME_VALUE = "/";

/**
 * A submenu component for selecting from a list of options.
 */
export class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsPicker;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue:
					(this.state.anthropicExtraUsage ?? SETTINGS_DEFAULTS.warnings.anthropicExtraUsage) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsPicker(
			items,
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
			{ title: "Warnings" },
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): boolean {
		this.settingsList.handleInput(data);
		return true;
	}
}

export class SelectSubmenu implements Component, Focusable {
	readonly capturesViewportInput = true;
	private readonly selector: Selector<string>;

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
		const items: SelectorItem<string>[] = options.map((option) => {
			const marked = option.label.startsWith("✓ ");
			const unmarked = !marked && option.label.startsWith("  ");
			const label = marked || unmarked ? option.label.slice(2) : option.label;
			return {
				id: option.value,
				value: option.value,
				label,
				...(option.description ? { description: option.description } : {}),
				...(marked ? { mark: "on" as const } : unmarked ? { mark: "off" as const } : {}),
			};
		});
		const current = items.some((item) => item.id === currentValue) ? currentValue : undefined;
		this.selector = new Selector<string>({
			title,
			...(description ? { subtitle: description } : {}),
			items,
			search: searchable,
			...(current === undefined ? {} : { initialId: current }),
			cancelLabel: "back",
			rightConfirms: false,
			onSelect: (item) => onSelect(item.value),
			onCancel,
			...(onSelectionChange ? { onSelectionChange: (item) => item && onSelectionChange(item.value) } : {}),
		});
	}

	get focused(): boolean {
		return this.selector.focused;
	}
	set focused(value: boolean) {
		this.selector.focused = value;
	}

	render(width: number): string[] {
		return this.selector.render(width);
	}

	handleInput(data: string): boolean {
		this.selector.handleInput(data);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.selector.handleMouse(event);
	}

	invalidate(): void {
		this.selector.invalidate();
	}
}

export function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		description: name === "system" ? "Use the terminal's foreground, background, and palette" : undefined,
	}));
}

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		...themeItems(
			availableThemes.filter((name) => name === "system"),
			currentTheme,
		),
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(
			availableThemes.filter((name) => name !== "system"),
			currentTheme,
		),
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

		const settingsList = new SettingsPicker(
			items,
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
			{
				title: "Automatic theme",
				subtitle:
					"Choose themes for terminal light and dark appearance.\nLight/dark detection requires terminal support.",
			},
		);
		this.setContent(settingsList);
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
