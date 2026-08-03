import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 * Canonical spelling of a path, for comparing one Node derived from `cwd`
 * against one git wrote into a `.git` file.
 *
 * `canonicalizePath` uses `realpathSync`, which resolves symlinks but leaves a
 * Windows 8.3 short component alone — and `os.tmpdir()` on a GitHub Windows
 * runner is exactly that (`C:\Users\RUNNER~1\AppData\Local\Temp`). Git records
 * the expanded long form in the `gitdir:` target, so the two spellings of one
 * directory never compared equal and the shadowing guard below silently did
 * nothing on Windows. `realpathSync.native` expands the short component; it is
 * the same pairing `subagents/runs/shared/worktree-root.ts` already relies on.
 */
function realPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return canonicalizePath(path);
	}
}

/** Windows compares paths case-insensitively; POSIX does not. */
function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `child` is a strict descendant of `directory`, under the same casing rule. */
function isDescendantOf(directory: string, child: string): boolean {
	const prefix = `${directory}${sep}`;
	return process.platform === "win32"
		? child.toLowerCase().startsWith(prefix.toLowerCase())
		: child.startsWith(prefix);
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * are the same tracked AGENTS.md/CLAUDE.md, so loading both loads it twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`) or short-named (Windows `RUNNER~1`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = realPath(gitPaths.commonGitDir);
	const worktreeRoot = realPath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!isDescendantOf(mainRepoRoot, worktreeRoot)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (!samePath(realPath(join(mainRepoRoot, ".git")), commonGitDir)) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? realPath(join(mainRepoRoot, basename(worktreeContextFile.path))) : undefined;
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
			shadowedContextFile !== undefined &&
			contextFile !== null &&
			samePath(realPath(contextFile.path), shadowedContextFile);
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}
