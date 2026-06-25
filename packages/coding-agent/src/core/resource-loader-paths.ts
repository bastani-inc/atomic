import { getAgentDir, getAgentDirs } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";

export function getLoaderAgentDirs(agentDir: string): string[] {
	return agentDir === getAgentDir() ? getAgentDirs() : [agentDir];
}

export function resolveResourcePath(cwd: string, path: string): string {
	return resolvePath(path, cwd, { trim: true });
}

export function mergeResourcePaths(cwd: string, primary: string[], additional: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const p of [...primary, ...additional]) {
		const resolved = resolveResourcePath(cwd, p);
		const canonicalPath = canonicalizePath(resolved);
		if (seen.has(canonicalPath)) continue;
		seen.add(canonicalPath);
		merged.push(resolved);
	}

	return merged;
}

