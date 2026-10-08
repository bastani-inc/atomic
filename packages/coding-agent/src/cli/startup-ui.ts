import { existsSync } from "node:fs";
import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { ENV_AGENT_DIR, getAgentDir, getEnvValue, getSettingsPath } from "../config.js";
import type { ExtensionUIDialogOptions } from "../core/extensions/index.js";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalThemeForAuto,
	initTheme,
	setTheme,
	type TerminalTheme,
} from "../modes/interactive/theme/theme.js";

function createStartupTui(settingsManager: SettingsManager): TUI {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Detect terminal appearance for first-run setup using one shared color query.
 * The terminal's background and foreground decide the result; unsupported
 * queries fall back to COLORFGBG and then dark.
 */
export async function detectStartupTheme(ui: TUI): Promise<TerminalTheme> {
	return detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
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
				onThemePreview: (name) => {
					setTheme(name);
					ui.requestRender();
				},
				onSubmit: (result) => {
					void finish(result);
				},
				onCancel: () => {
					void finish(undefined);
				},
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
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		if (dialogOptions?.signal?.aborted) {
			resolve(undefined);
			return;
		}
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			dialogOptions?.signal?.removeEventListener("abort", abandon);
			selector.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};
		const abandon = () => void finish(undefined);
		dialogOptions?.signal?.addEventListener("abort", abandon, { once: true });

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui, timeout: dialogOptions?.timeout },
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
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (dialogOptions?.signal?.aborted) {
			resolve(undefined);
			return;
		}
		const ui = createStartupTui(settingsManager);

		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			dialogOptions?.signal?.removeEventListener("abort", abandon);
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};
		const abandon = () => void finish(undefined);
		dialogOptions?.signal?.addEventListener("abort", abandon, { once: true });

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{ tui: ui, timeout: dialogOptions?.timeout },
		);
		ui.addChild(input);
		ui.setFocus(input);
		ui.start();
	});
}
