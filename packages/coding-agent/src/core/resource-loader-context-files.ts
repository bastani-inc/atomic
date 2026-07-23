import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { getAgentDir, getAgentDirs } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";

export function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export function getAncestorDirectories(
	startDir: string,
	parentOf: (path: string) => string = dirname,
): string[] {
	const directories: string[] = [];
	let currentDir = startDir;
	while (true) {
		directories.push(currentDir);
		const parentDir = parentOf(currentDir);
		if (parentDir === currentDir) return directories;
		currentDir = parentDir;
	}
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	projectTrusted?: boolean;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const contextAgentDirs = Array.from(
		new Set(resolvedAgentDir === getAgentDir() ? getAgentDirs() : [resolvedAgentDir]),
	).reverse();
	for (const agentDir of contextAgentDirs) {
		const context = loadContextFileFromDir(agentDir);
		if (context && !seenPaths.has(context.path)) {
			contextFiles.push(context);
			seenPaths.add(context.path);
		}
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];
	if (options.projectTrusted === false) {
		return contextFiles;
	}

	for (const currentDir of getAncestorDirectories(resolvedCwd)) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}
