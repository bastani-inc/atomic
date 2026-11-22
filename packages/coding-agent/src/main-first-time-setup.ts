import { existsSync } from "node:fs";
import { ENV_AGENT_DIR, getEnvValue, getSettingsPath } from "./config.js";
import type { SettingsManager } from "./core/settings-manager.ts";
import type { AppMode } from "./main-app-mode.ts";
import type { EarlyInputCapture } from "./main-early-input.ts";

export async function runFirstTimeSetup(
	appMode: AppMode,
	settingsManager: SettingsManager,
	capture: EarlyInputCapture | undefined,
): Promise<EarlyInputCapture | undefined> {
	if (appMode !== "interactive" || getEnvValue(ENV_AGENT_DIR) || existsSync(getSettingsPath())) return capture;
	const { shouldRunFirstTimeSetup, showFirstTimeSetup } = await import("./cli/startup-ui.ts");
	if (!shouldRunFirstTimeSetup()) return capture;
	await showFirstTimeSetup(settingsManager);
	return capture;
}
