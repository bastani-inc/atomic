import { existsSync } from "node:fs";
import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { ENV_AGENT_DIR, getAgentDir, getEnvValue, getSettingsPath } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	DURABILITY_BACKEND_HELP,
	DURABILITY_BACKEND_QUESTION,
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalThemeForAuto,
	initTheme,
	setTheme,
	type TerminalTheme,
} from "../modes/interactive/theme/theme.ts";
import { normalizeAndValidateDbosSystemDatabaseUrl } from "./dbos-durability-onboarding.ts";

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
 * Detect the terminal theme for first-run setup. The colour-scheme (DSR 996)
 * and background (OSC 11) probes start concurrently through
 * `detectTerminalThemeForAuto`, so a terminal that answers neither costs one
 * timeout window instead of two. Exported for probe-concurrency coverage.
 */
export async function detectStartupTheme(ui: TUI): Promise<TerminalTheme> {
	return detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
}

/** First-run setup is eligible only in the default agent directory before settings.json exists. */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	return !getEnvValue(ENV_AGENT_DIR) && !existsSync(settingsPath);
}

export function shouldRunDurabilitySetup(
	settingsManager: SettingsManager,
	envUrl: string | undefined = process.env.DBOS_SYSTEM_DATABASE_URL,
): boolean {
	return settingsManager.getDbosSystemDatabaseUrl() === undefined && !envUrl?.trim();
}

export async function showDurabilitySetup(settingsManager: SettingsManager): Promise<void> {
	const ui = createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		let validating = false;
		const finish = async (value: string | undefined) => {
			if (settled) return;
			settled = true;
			if (value !== undefined) {
				settingsManager.setDbosSystemDatabaseUrl(value);
				await settingsManager.flush();
			}
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};
		const input = new ExtensionInputComponent(
			`${DURABILITY_BACKEND_QUESTION}\n${DURABILITY_BACKEND_HELP}`,
			undefined,
			(value) => {
				if (validating) return;
				validating = true;
				input.setError(undefined);
				void normalizeAndValidateDbosSystemDatabaseUrl(value).then(
					(normalized) => finish(normalized),
					(error: Error) => {
						validating = false;
						input.setError(error.message);
						ui.requestRender();
					},
				);
			},
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(input);
		ui.setFocus(input);
		ui.start();
	});
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
				if (result.dbosSystemDatabaseUrl !== undefined) {
					settingsManager.setDbosSystemDatabaseUrl(result.dbosSystemDatabaseUrl);
				}
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
				skipDurability: Boolean(process.env.DBOS_SYSTEM_DATABASE_URL?.trim()),
				onThemePreview: (name) => {
					setTheme(name);
					ui.requestRender();
				},
				onValidateDurability: normalizeAndValidateDbosSystemDatabaseUrl,
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
