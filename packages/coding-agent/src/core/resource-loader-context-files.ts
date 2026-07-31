import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import chalk from "chalk";
import { getAgentDir, getAgentDirs } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { findGitPaths } from "./footer-data-provider.ts";

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

/**
 * Path of a system-prompt input that is a real file, for startup disclosure.
 * `resolvePromptInput` also accepts literal prompt text, which has no path.
 */
export function resolveExistingPromptSourcePath(input: string | undefined): string | undefined {
	return input && existsSync(input) ? resolvePath(input) : undefined;
}

export function resolveExistingPromptSourcePaths(inputs: readonly string[]): string[] {
	return inputs
		.map((input) => resolveExistingPromptSourcePath(input))
		.filter((path): path is string => path !== undefined);
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) continue;
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

export function getAncestorDirectories(startDir: string, parentOf: (path: string) => string = dirname): string[] {
	const directories: string[] = [];
	let currentDir = startDir;
	while (true) {
		directories.push(currentDir);
		const parentDir = parentOf(currentDir);
		if (parentDir === currentDir) return directories;
		currentDir = parentDir;
	}
}
/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * are the same tracked AGENTS.md/CLAUDE.md, so loading both loads it twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
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

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	for (const currentDir of getAncestorDirectories(resolvedCwd)) {
		const contextFile = loadContextFileFromDir(currentDir);
		// A nested linked worktree's own AGENTS.md/CLAUDE.md and the main repo's copy
		// are the same tracked file; skip the main repo's so it is not loaded twice.
		const isShadowed =
			shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? "") === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}
