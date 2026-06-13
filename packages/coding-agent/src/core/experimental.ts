import { APP_NAME, LEGACY_ENV_PREFIX } from "../config.ts";

export function areExperimentalFeaturesEnabled(): boolean {
	return process.env[`${APP_NAME.toUpperCase()}_EXPERIMENTAL`] === "1" || process.env[`${LEGACY_ENV_PREFIX}_EXPERIMENTAL`] === "1";
}
