/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, setCapabilityOverrides, setKeybindings, TuiMainScreen } from "@bastani/atomic-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.js";

export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	setCapabilityOverrides(options.settingsManager.getTerminalCapabilityOverrides());
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);
	setKeybindings(KeybindingsManager.create(options.agentDir));

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), undefined, options.agentDir);
		let resolved = false;
		const close = () => {
			if (resolved) return;
			resolved = true;
			ui.stop();
			stopThemeWatcher();
			resolve();
		};

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			close,
			close,
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
			() => ui.terminal.rows,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
