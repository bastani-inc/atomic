import { access } from "node:fs/promises";
import { getUserConfigPaths } from "@bastani/atomic";

export const WEB_SEARCH_CONFIG_PATHS = getUserConfigPaths("web-search.json");
export const WEB_SEARCH_CONFIG_PATH = WEB_SEARCH_CONFIG_PATHS[0] ?? "~/.atomic/web-search.json";
export const EXA_USAGE_PATHS = getUserConfigPaths("exa-usage.json");
export const EXA_USAGE_PATH = EXA_USAGE_PATHS[0] ?? "~/.atomic/exa-usage.json";

export async function findReadableConfigPath(paths = WEB_SEARCH_CONFIG_PATHS): Promise<string> {
	for (const path of paths) {
		try {
			await access(path);
			return path;
		} catch {}
	}
	return paths[0] ?? WEB_SEARCH_CONFIG_PATH;
}
