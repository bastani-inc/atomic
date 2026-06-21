import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { getLoaderAgentDirs } from "./resource-loader-paths.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";

export function discoverSystemPromptFile(loader: DefaultResourceLoader): string | undefined {
	const state = resourceInternals(loader);
	const projectCandidates = state.settingsManager.isProjectTrusted()
		? getProjectConfigDirs(state.cwd).map((configDir) => join(configDir, "SYSTEM.md"))
		: [];
	const candidates = [
		...projectCandidates,
		...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "SYSTEM.md")),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

export function discoverAppendSystemPromptFile(loader: DefaultResourceLoader): string | undefined {
	const state = resourceInternals(loader);
	const projectCandidates = state.settingsManager.isProjectTrusted()
		? getProjectConfigDirs(state.cwd).map((configDir) => join(configDir, "APPEND_SYSTEM.md"))
		: [];
	const candidates = [
		...projectCandidates,
		...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "APPEND_SYSTEM.md")),
	];
	return candidates.find((candidate) => existsSync(candidate));
}
