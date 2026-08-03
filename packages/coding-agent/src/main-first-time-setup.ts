import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "./cli/startup-ui.ts";
import type { SettingsManager } from "./core/settings-manager.ts";
import type { AppMode } from "./main-app-mode.ts";
import type { EarlyInputCapture } from "./main-early-input.ts";

/** Run setup before interactive mode and release any early-input capture owned by startup. */
export async function runFirstTimeSetup(
	appMode: AppMode,
	settingsManager: SettingsManager,
	capture: EarlyInputCapture | undefined,
): Promise<EarlyInputCapture | undefined> {
	if (appMode !== "interactive" || !shouldRunFirstTimeSetup()) return capture;
	capture?.consume();
	await showFirstTimeSetup(settingsManager);
	return undefined;
}
