import * as fs from "node:fs";
import { getAgentConfigPaths } from "@bastani/atomic";
import { type ExtensionConfig, RESUME_IN_FLIGHT_MODES, type ResumeInFlight } from "../shared/types.js";

function withoutInvalidResumeInFlight(config: ExtensionConfig, configPath: string): ExtensionConfig {
	const value: ResumeInFlight | undefined = config.resumeInFlight;
	if (value === undefined || RESUME_IN_FLIGHT_MODES.some((mode) => mode === value)) return config;
	console.error(
		`Invalid subagent config '${configPath}': "resumeInFlight" must be "ask", "auto", or "never", got ${JSON.stringify(value)}`,
	);
	const { resumeInFlight: _ignored, ...rest } = config;
	return rest;
}

export function loadConfig(): ExtensionConfig {
	for (const configPath of getAgentConfigPaths("extensions", "subagent", "config.json")) {
		try {
			if (fs.existsSync(configPath)) {
				return withoutInvalidResumeInFlight(
					JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig,
					configPath,
				);
			}
		} catch (error) {
			console.error(`Failed to load subagent config from '${configPath}':`, error);
		}
	}
	return {};
}
