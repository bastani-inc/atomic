import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { SYSTEM_THEME_NAME } from "./system-theme.js";
import {
	getTerminalTheme,
	markTerminalColorsPending,
	setTerminalColorScheme,
	setTerminalColors,
} from "./terminal-colors.js";
import {
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.js";

type ThemeResult = { success: boolean; error?: string };
const TERMINAL_QUERY_TIMEOUT_MS = 100;
export function requestTerminalColors(
	ui: Pick<TUI, "queryTerminalColors">,
	apply: (colors: TerminalColors) => void,
): Promise<void> {
	let query: Promise<TerminalColors>;
	try {
		query = ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
	} catch {
		query = Promise.resolve({});
	}
	return query.then(apply, () => apply({}));
}
function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}
function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	if (a.palette === b.palette) return true;
	return (
		!!a.palette &&
		!!b.palette &&
		a.palette.length === b.palette.length &&
		a.palette.every((color, index) => sameRgb(color, b.palette?.[index]))
	);
}
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	private terminalColors: TerminalColors | undefined;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	private terminalColorQuery: Promise<void> = Promise.resolve();
	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = this.resolveThemeName();
		markTerminalColorsPending();
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}
	async applyFromSettings(): Promise<void> {
		const setting = this.getThemeSetting();
		const name = this.resolveThemeName();
		this.setAutoSync(parseAutoThemeSetting(setting) !== undefined || name === SYSTEM_THEME_NAME);
		this.applyThemeName(name, setting !== undefined);
		this.queryTerminalColors();
		await this.waitForTerminalColors();
	}
	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}
	getThemeSelection(): string | undefined {
		return this.getThemeSetting() ?? this.activeThemeName;
	}
	setThemeName(name: string, showError = false): ThemeResult {
		this.setAutoSync(name === SYSTEM_THEME_NAME);
		const result = this.applyThemeName(name, showError);
		if (result.success) this.currentThemeSetting = name;
		return result;
	}
	async setThemeSetting(setting: string): Promise<void> {
		this.currentThemeSetting = setting;
		await this.applyFromSettings();
	}
	setThemeInstance(instance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(instance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}
	preview(setting: string): void {
		const name = resolveThemeSetting(setting, getTerminalTheme()) ?? this.activeThemeName;
		if (name && setTheme(name, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}
	disableAutoSync(): void {
		this.setAutoSync(false);
	}
	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}
	dispose(): void {
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
	}
	getTerminalTheme(): TerminalTheme {
		return getTerminalTheme();
	}
	private getThemeSetting(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}
	// Keep Atomic's existing light/dark palettes as the unconfigured default.
	private resolveThemeName(): string {
		return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? getTerminalTheme();
	}
	private applyThemeName(name: string, showError = false): ThemeResult {
		const result = setTheme(name, true);
		this.activeThemeName = result.success ? name : "dark";
		this.notifyChanged();
		if (!result.success && showError)
			this.showError(`Failed to load theme "${name}": ${result.error}\nFell back to dark theme.`);
		return result;
	}
	private queryTerminalColors(): void {
		this.terminalColorQuery = requestTerminalColors(this.ui, (colors) => this.applyTerminalColors(colors));
	}
	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};
		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}
	private reapplyForTerminal(): void {
		if (this.activeThemeName === "<in-memory>") return;
		const name = this.resolveThemeName();
		if (name === SYSTEM_THEME_NAME || name !== this.activeThemeName) this.applyThemeName(name);
	}
	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}
	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((scheme) => {
			if (!this.autoSyncEnabled) return;
			const previous = getTerminalTheme();
			setTerminalColorScheme(scheme);
			if (getTerminalTheme() !== previous) this.reapplyForTerminal();
			this.queryTerminalColors();
		});
	}
	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}
}
