import { existsSync } from "node:fs";
import { ENV_AGENT_DIR, getEnvValue, getSettingsPath } from "../config.js";

/** First-run setup is eligible only in the default agent directory before settings.json exists. */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	return !getEnvValue(ENV_AGENT_DIR) && !existsSync(settingsPath);
}
