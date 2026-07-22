import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { ENV_AGENT_DIR, getEnvValue, getSettingsPath } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { FirstTimeSetupComponent, type FirstTimeSetupResult } from "../modes/interactive/components/first-time-setup.ts";
import { detectTerminalBackgroundTheme, initTheme, setTheme, type TerminalTheme } from "../modes/interactive/theme/theme.ts";

function createStartupTui(settingsManager: SettingsManager): TUI {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

async function detectStartupTheme(ui: TUI): Promise<TerminalTheme> {
	try {
		const scheme = await ui.queryTerminalColorScheme({ timeoutMs: 100 });
		if (scheme) return scheme;
	} catch {}
	return (await detectTerminalBackgroundTheme({ ui, timeoutMs: 100 })).theme;
}

/** First-run setup is eligible only in the default agent directory before settings.json exists. */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	return !getEnvValue(ENV_AGENT_DIR) && !existsSync(settingsPath);
}

export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) return;
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};
		void (async () => {
			ui.start();
			const detectedTheme = await detectStartupTheme(ui);
			setTheme(detectedTheme);
			const setup = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (name) => { setTheme(name); ui.requestRender(); },
				onSubmit: (result) => { void finish(result); },
				onCancel: () => { void finish(undefined); },
			});
			ui.addChild(setup);
			ui.setFocus(setup);
			ui.requestRender();
		})();
	});
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(input);
		ui.setFocus(input);
		ui.start();
	});
}
