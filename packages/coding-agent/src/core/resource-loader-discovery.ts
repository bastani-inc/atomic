import { access } from "node:fs/promises";
import { join } from "node:path";
import { getProjectConfigDirs } from "../config.js";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { getLoaderAgentDirs } from "./resource-loader-paths.ts";

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

/** The first of `candidates` that exists. */
async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

export function discoverSystemPromptFile(loader: DefaultResourceLoader): Promise<string | undefined> {
	const state = resourceInternals(loader);
	const projectCandidates = state.settingsManager.isProjectTrusted()
		? getProjectConfigDirs(state.cwd).map((configDir) => join(configDir, "SYSTEM.md"))
		: [];
	const candidates = [
		...projectCandidates,
		...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "SYSTEM.md")),
	];
	return firstExisting(candidates);
}

export function discoverAppendSystemPromptFile(loader: DefaultResourceLoader): Promise<string | undefined> {
	const state = resourceInternals(loader);
	const projectCandidates = state.settingsManager.isProjectTrusted()
		? getProjectConfigDirs(state.cwd).map((configDir) => join(configDir, "APPEND_SYSTEM.md"))
		: [];
	const candidates = [
		...projectCandidates,
		...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "APPEND_SYSTEM.md")),
	];
	return firstExisting(candidates);
}
