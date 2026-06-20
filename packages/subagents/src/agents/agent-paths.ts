import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentConfigPaths, getProjectConfigDirs } from "@bastani/atomic";

export function getUserChainDir(): string {
	return getAgentConfigPaths("chains")[0] ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "chains");
}

export function getUserChainDirs(): string[] {
	return getAgentConfigPaths("chains");
}

export function getUserAgentDirs(): string[] {
	return getAgentConfigPaths("agents");
}

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (getProjectConfigDirs(currentDir).some(isDirectory) || isDirectory(path.join(currentDir, ".agents"))) {
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

export function getProjectAgentSettingsPath(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? path.join(getProjectConfigDirs(projectRoot)[0]!, "settings.json") : null;
}

export function getProjectAgentSettingsPaths(cwd: string): string[] {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? getProjectConfigDirs(projectRoot).map((dir) => path.join(dir, "settings.json")) : [];
}

export function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const legacyDir = path.join(projectRoot, ".agents");
	const preferredDir = path.join(getProjectConfigDirs(projectRoot)[0]!, "agents");
	const readDirs: string[] = [];
	if (isDirectory(legacyDir)) readDirs.push(legacyDir);
	for (const configDir of getProjectConfigDirs(projectRoot).reverse()) {
		const agentsDir = path.join(configDir, "agents");
		if (isDirectory(agentsDir)) readDirs.push(agentsDir);
	}

	return {
		readDirs,
		preferredDir,
	};
}

export function resolveNearestProjectChainDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const preferredDir = path.join(getProjectConfigDirs(projectRoot)[0]!, "chains");
	return {
		readDirs: getProjectConfigDirs(projectRoot).reverse().map((configDir) => path.join(configDir, "chains")).filter(isDirectory),
		preferredDir,
	};
}

export const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
