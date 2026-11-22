import { stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentConfigPaths, getProjectConfigDirs } from "@bastani/atomic";

export function getUserAgentDirs(): string[] {
	return getAgentConfigPaths("agents");
}

/**
 * The user agent directories in the order discovery reads them; a later directory's agent replaces an earlier one's
 * of the same name. Legacy `~/.pi/agent/agents` comes first, then `~/.agents`, then Atomic's own agent directory,
 * which wins as `.atomic/agents` does in a project.
 */
export function getUserAgentReadDirs(): string[] {
	const dirs = getUserAgentDirs();
	return [...dirs.slice(1), path.join(os.homedir(), ".agents"), ...dirs.slice(0, 1)];
}

export async function isDirectory(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function someDirectory(paths: readonly string[]): Promise<boolean> {
	for (const p of paths) if (await isDirectory(p)) return true;
	return false;
}

export async function findNearestProjectRoot(cwd: string): Promise<string | null> {
	let currentDir = cwd;
	while (true) {
		if (
			(await someDirectory(getProjectConfigDirs(currentDir))) ||
			(await isDirectory(path.join(currentDir, ".agents")))
		) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function getUserAgentSettingsPath(): string {
	return getAgentConfigPaths("settings.json")[0] ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json");
}

export function getUserAgentSettingsPaths(): string[] {
	return getAgentConfigPaths("settings.json");
}

export async function getProjectAgentSettingsPath(cwd: string): Promise<string | null> {
	const projectRoot = await findNearestProjectRoot(cwd);
	return projectRoot ? path.join(getProjectConfigDirs(projectRoot)[0]!, "settings.json") : null;
}

export async function getProjectAgentSettingsPaths(cwd: string): Promise<string[]> {
	const projectRoot = await findNearestProjectRoot(cwd);
	return projectRoot ? getProjectConfigDirs(projectRoot).map((dir) => path.join(dir, "settings.json")) : [];
}

export async function resolveNearestProjectAgentDirs(
	cwd: string,
): Promise<{ readDirs: string[]; preferredDir: string | null }> {
	const projectRoot = await findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const legacyDir = path.join(projectRoot, ".agents");
	const preferredDir = path.join(getProjectConfigDirs(projectRoot)[0]!, "agents");
	const readDirs: string[] = [];
	if (await isDirectory(legacyDir)) readDirs.push(legacyDir);
	for (const configDir of getProjectConfigDirs(projectRoot).reverse()) {
		const agentsDir = path.join(configDir, "agents");
		if (await isDirectory(agentsDir)) readDirs.push(agentsDir);
	}

	return {
		readDirs,
		preferredDir,
	};
}

export const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
