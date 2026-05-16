import { existsSync } from "node:fs";
import { getUserConfigPaths } from "@bastani/atomic";

export const WEB_SEARCH_CONFIG_PATHS = getUserConfigPaths("web-search.json");
export const WEB_SEARCH_CONFIG_PATH = WEB_SEARCH_CONFIG_PATHS[0] ?? "~/.atomic/web-search.json";
export const EXA_USAGE_PATHS = getUserConfigPaths("exa-usage.json");
export const EXA_USAGE_PATH = EXA_USAGE_PATHS[0] ?? "~/.atomic/exa-usage.json";

export function findReadableConfigPath(paths = WEB_SEARCH_CONFIG_PATHS): string {
	return paths.find((path) => existsSync(path)) ?? paths[0] ?? WEB_SEARCH_CONFIG_PATH;
}
