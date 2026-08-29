import { Container, type Focusable, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export const DURABILITY_BACKEND_QUESTION = "What durable backend would you like to use for workflows?";
export const DURABILITY_BACKEND_HELP =
	"Leave empty to use Atomic’s embedded PostgreSQL, or enter a PostgreSQL connection URL for a hosted or self-hosted instance.";

export interface FirstTimeSetupResult {
	theme: TerminalTheme;
	dbosSystemDatabaseUrl?: string;
	shareAnalytics: boolean;
}
export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	onThemePreview(themeName: TerminalTheme): void;
	skipDurability?: boolean;
	onValidateDurability(value: string): Promise<string>;
	onSubmit(result: FirstTimeSetupResult): void;
	onCancel(): void;
}
const THEMES: Array<{ value: TerminalTheme; label: string }> = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];
const ANALYTICS = [
	{ value: true, label: "Share anonymous usage data" },
	{ value: false, label: "Don't share" },
];

export class FirstTimeSetupComponent extends Container implements Focusable {
	private step: "theme" | "durability" | "analytics" = "theme";
	private themeIndex: number;
	private analyticsIndex = 0;
	private durabilityUrl: string | undefined;
	private durabilityError: string | undefined;
	private validatingDurability = false;
	private readonly durabilityInput = new Input();
	private readonly options: FirstTimeSetupOptions;
	private _focused = false;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = Math.max(
			0,
			THEMES.findIndex((option) => option.value === options.detectedTheme),
		);
		this.update();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.durabilityInput.focused = value;
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
			this.addOptions(
				THEMES.map((option) => option.label),
				this.themeIndex,
			);
		} else if (this.step === "durability") {
			this.addChild(new Text(theme.fg("text", DURABILITY_BACKEND_QUESTION), 1, 0));
			this.addChild(new Text(theme.fg("muted", DURABILITY_BACKEND_HELP), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.durabilityInput);
			if (this.durabilityError) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.durabilityError), 1, 0));
			}
		} else {
			this.addChild(new Text(theme.fg("text", "Opt in to anonymous usage analytics?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						"This choice and a random tracking ID are stored locally in settings.json.\nAtomic does not transmit analytics data in this release. You can change this setting anytime.",
					),
					1,
					0,
				),
			);
			this.addOptions(
				ANALYTICS.map((option) => option.label),
				this.analyticsIndex,
			);
		}
		this.addChild(new Spacer(1));
		const confirmLabel =
			this.step === "theme" ? "continue" : this.step === "durability" ? "validate & continue" : "finish";
		this.addChild(
			new Text(
				`${this.step === "durability" ? "" : `${rawKeyHint("↑↓", "navigate")}  `}${keyHint("tui.select.confirm", confirmLabel)}  ${keyHint("tui.select.cancel", "skip setup")}`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	private addOptions(labels: string[], selected: number): void {
		for (let index = 0; index < labels.length; index++) {
			this.addChild(
				new Text(
					index === selected
						? theme.fg("accent", `→ ${labels[index]}`)
						: `  ${theme.fg("text", labels[index] ?? "")}`,
					1,
					0,
				),
			);
		}
	}

	private move(delta: number): void {
		if (this.step === "theme") {
			this.themeIndex = Math.max(0, Math.min(THEMES.length - 1, this.themeIndex + delta));
			this.options.onThemePreview(THEMES[this.themeIndex]!.value);
		} else if (this.step === "analytics") {
			this.analyticsIndex = Math.max(0, Math.min(ANALYTICS.length - 1, this.analyticsIndex + delta));
		}
		this.update();
	}

	private async validateDurability(): Promise<void> {
		if (this.validatingDurability) return;
		this.validatingDurability = true;
		this.durabilityError = undefined;
		this.update();
		try {
			this.durabilityUrl = await this.options.onValidateDurability(this.durabilityInput.getValue());
			this.step = "analytics";
		} catch (error) {
			this.durabilityError = error instanceof Error ? error.message : String(error);
		} finally {
			this.validatingDurability = false;
			this.update();
		}
	}

	handleInput(data: string): boolean {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		} else if (this.step === "durability") {
			if (keys.matches(data, "tui.select.confirm") || data === "\n") void this.validateDurability();
			else if (!this.validatingDurability) this.durabilityInput.handleInput(data);
		} else if (keys.matches(data, "tui.select.up") || data === "k") this.move(-1);
		else if (keys.matches(data, "tui.select.down") || data === "j") this.move(1);
		else if (keys.matches(data, "tui.select.confirm") || data === "\n") {
			if (this.step === "theme") {
				this.step = this.options.skipDurability ? "analytics" : "durability";
				this.update();
			} else {
				this.options.onSubmit({
					theme: THEMES[this.themeIndex]!.value,
					...(this.durabilityUrl === undefined ? {} : { dbosSystemDatabaseUrl: this.durabilityUrl }),
					shareAnalytics: ANALYTICS[this.analyticsIndex]!.value,
				});
			}
		} else return false;
		return true;
	}
}
