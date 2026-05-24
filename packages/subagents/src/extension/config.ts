import * as fs from "node:fs";
import { getAgentConfigPaths } from "@bastani/atomic";
import type { ExtensionConfig } from "../shared/types.ts";

export function loadConfig(): ExtensionConfig {
	for (const configPath of getAgentConfigPaths("extensions", "subagent", "config.json")) {
		try {
			if (fs.existsSync(configPath)) {
				return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
			}
		} catch (error) {
			console.error(`Failed to load subagent config from '${configPath}':`, error);
		}
	}
	return {};
}
