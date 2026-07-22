import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult { theme: TerminalTheme; shareAnalytics: boolean }
export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	onThemePreview(themeName: TerminalTheme): void;
	onSubmit(result: FirstTimeSetupResult): void;
	onCancel(): void;
}
const THEMES: Array<{ value: TerminalTheme; label: string }> = [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }];
const ANALYTICS = [{ value: true, label: "Share anonymous usage data" }, { value: false, label: "Don't share" }];

export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme";
	private themeIndex: number;
	private analyticsIndex = 0;
	constructor(private readonly options: FirstTimeSetupOptions) {
		super();
		this.themeIndex = Math.max(0, THEMES.findIndex((option) => option.value === options.detectedTheme));
		this.update();
	}
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}.`)), 1, 0));
		this.addChild(new Spacer(1));
		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
			this.addOptions(THEMES.map((option) => option.label), this.themeIndex);
		} else {
			this.addChild(new Text(theme.fg("text", "Opt in to anonymous usage analytics?"), 1, 0));
			this.addChild(new Text(theme.fg("muted", "This choice and a random tracking ID are stored locally in settings.json.\nAtomic does not transmit analytics data in this release. You can change this setting anytime."), 1, 0));
			this.addOptions(ANALYTICS.map((option) => option.label), this.analyticsIndex);
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", this.step === "theme" ? "continue" : "finish")}  ${keyHint("tui.select.cancel", "skip setup")}`, 1, 0));
		this.addChild(new DynamicBorder());
	}
	private addOptions(labels: string[], selected: number): void {
		for (let index = 0; index < labels.length; index++) {
			this.addChild(new Text(index === selected ? theme.fg("accent", `→ ${labels[index]}`) : `  ${theme.fg("text", labels[index] ?? "")}`, 1, 0));
		}
	}
	private move(delta: number): void {
		if (this.step === "theme") {
			this.themeIndex = Math.max(0, Math.min(THEMES.length - 1, this.themeIndex + delta));
			this.options.onThemePreview(THEMES[this.themeIndex]!.value);
		} else this.analyticsIndex = Math.max(0, Math.min(ANALYTICS.length - 1, this.analyticsIndex + delta));
		this.update();
	}
	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.up") || data === "k") this.move(-1);
		else if (keys.matches(data, "tui.select.down") || data === "j") this.move(1);
		else if (keys.matches(data, "tui.select.confirm") || data === "\n") {
			if (this.step === "theme") { this.step = "analytics"; this.update(); }
			else this.options.onSubmit({ theme: THEMES[this.themeIndex]!.value, shareAnalytics: ANALYTICS[this.analyticsIndex]!.value });
		} else if (keys.matches(data, "tui.select.cancel")) this.options.onCancel();
	}
}
