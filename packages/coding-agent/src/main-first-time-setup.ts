import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "./cli/startup-ui.ts";
import type { SettingsManager } from "./core/settings-manager.ts";
import type { AppMode } from "./main-app-mode.ts";
import type { EarlyInputCapture } from "./main-early-input.ts";

/**
 * Run setup before interactive mode. The setup screen takes the terminal from the early-input capture while it is
 * open, and what was typed comes back as a draft, so the capture is returned to keep reading after it.
 */
export async function runFirstTimeSetup(
	appMode: AppMode,
	settingsManager: SettingsManager,
	capture: EarlyInputCapture | undefined,
): Promise<EarlyInputCapture | undefined> {
	if (appMode !== "interactive" || !shouldRunFirstTimeSetup()) return capture;
	await showFirstTimeSetup(settingsManager);
	return capture;
}
