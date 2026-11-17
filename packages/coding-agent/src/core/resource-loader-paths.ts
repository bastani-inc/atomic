import { getAgentDir, getAgentDirs } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import { getResourcePathKeyAsync, isSyntheticPath } from "./source-info.ts";

export function getLoaderAgentDirs(agentDir: string): string[] {
	return agentDir === getAgentDir() ? getAgentDirs() : [agentDir];
}

export function resolveResourcePath(cwd: string, path: string): string {
	return isSyntheticPath(path) ? path : resolvePath(path, cwd, { trim: true });
}

export async function mergeResourcePaths(cwd: string, primary: string[], additional: string[]): Promise<string[]> {
	const merged: string[] = [];
	const seen = new Set<string>();
	const resolvedPaths = [...primary, ...additional].map((p) => resolveResourcePath(cwd, p));
	const pathKeys = await Promise.all(resolvedPaths.map((resolved) => getResourcePathKeyAsync(resolved)));

	for (const [index, resolved] of resolvedPaths.entries()) {
		const pathKey = pathKeys[index]!;
		if (seen.has(pathKey)) continue;
		seen.add(pathKey);
		merged.push(resolved);
	}

	return merged;
}
