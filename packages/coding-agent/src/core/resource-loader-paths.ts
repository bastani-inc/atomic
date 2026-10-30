import { getAgentDir, getAgentDirs } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { getResourcePathKey, isSyntheticPath } from "./source-info.ts";

export function getLoaderAgentDirs(agentDir: string): string[] {
	return agentDir === getAgentDir() ? getAgentDirs() : [agentDir];
}

export function resolveResourcePath(cwd: string, path: string): string {
	return isSyntheticPath(path) ? path : resolvePath(path, cwd, { trim: true });
}

export function mergeResourcePaths(cwd: string, primary: string[], additional: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const p of [...primary, ...additional]) {
		const resolved = resolveResourcePath(cwd, p);
		const pathKey = getResourcePathKey(resolved);
		if (seen.has(pathKey)) continue;
		seen.add(pathKey);
		merged.push(resolved);
	}

	return merged;
}
