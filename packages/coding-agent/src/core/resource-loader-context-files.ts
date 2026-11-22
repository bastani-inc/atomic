import { existsSync, readFileSync, realpath as realpathCallback, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import chalk from "chalk";
import { getAgentDir, getAgentDirs } from "../config.js";
import { pathExists as exists } from "../utils/path-exists.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { findGitPaths, findGitPathsAsync } from "./footer-data-provider.ts";

type ContextFile = { path: string; content: string };

const emitWarningDefault = (message: string): void => {
	console.error(message);
};

export async function resolvePromptInput(
	input: string | undefined,
	description: string,
	onWarning: (message: string) => void = emitWarningDefault,
): Promise<string | undefined> {
	if (!input) {
		return undefined;
	}

	if (await exists(input)) {
		try {
			return stripBom(await readFile(input, "utf-8"));
		} catch (error) {
			onWarning(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

/**
 * Path of a system-prompt input that is a real file, for startup disclosure.
 * `resolvePromptInput` also accepts literal prompt text, which has no path.
 */
export async function resolveExistingPromptSourcePath(input: string | undefined): Promise<string | undefined> {
	return input && (await exists(input)) ? resolvePath(input) : undefined;
}

export async function resolveExistingPromptSourcePaths(inputs: readonly string[]): Promise<string[]> {
	const paths = await Promise.all(inputs.map((input) => resolveExistingPromptSourcePath(input)));
	return paths.filter((path): path is string => path !== undefined);
}

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadContextFileFromDir(dir: string): ContextFile | null {
	for (const filename of CONTEXT_FILE_NAMES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) continue;
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

async function loadContextFileFromDirAsync(
	dir: string,
	onWarning: (message: string) => void = emitWarningDefault,
): Promise<ContextFile | null> {
	for (const filename of CONTEXT_FILE_NAMES) {
		const filePath = join(dir, filename);
		if (await exists(filePath)) {
			try {
				if (!(await stat(filePath)).isFile()) continue;
				return {
					path: filePath,
					content: stripBom(await readFile(filePath, "utf-8")),
				};
			} catch (error) {
				onWarning(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
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

const realpathJs = promisify(realpathCallback);

async function realPathAsync(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return realpathJs(path).catch(() => path);
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
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned as the main repo root's real path joined with the selected file name, not
 * the file's own real path: `git worktree add` writes the `.git` file's `gitdir:` target
 * in realpath form while cwd may still be symlinked (macOS `/tmp` -> `/private/tmp`) or
 * short-named (Windows `RUNNER~1`), and a worktree context file that symlinks to the main
 * repo's copy would otherwise resolve to the shadowed path itself.
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
	if (!worktreeContextFile) return undefined;
	// An override replaces every context candidate in its directory, so it shadows
	// the main checkout's selected candidate even when the filenames differ.
	if (basename(worktreeContextFile.path) === "AGENTS.override.md") {
		const mainRepoContextFile = loadContextFileFromDir(mainRepoRoot);
		return mainRepoContextFile ? join(mainRepoRoot, basename(mainRepoContextFile.path)) : undefined;
	}
	return join(mainRepoRoot, basename(worktreeContextFile.path));
}

async function findShadowedContextFileAsync(
	cwd: string,
	onWarning: (message: string) => void = emitWarningDefault,
): Promise<string | undefined> {
	const gitPaths = await findGitPathsAsync(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = await realPathAsync(gitPaths.commonGitDir);
	const worktreeRoot = await realPathAsync(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	if (!isDescendantOf(mainRepoRoot, worktreeRoot)) return undefined;
	if (!samePath(await realPathAsync(join(mainRepoRoot, ".git")), commonGitDir)) return undefined;
	const worktreeContextFile = await loadContextFileFromDirAsync(worktreeRoot, onWarning);
	if (!worktreeContextFile) return undefined;
	if (basename(worktreeContextFile.path) === "AGENTS.override.md") {
		const mainRepoContextFile = await loadContextFileFromDirAsync(mainRepoRoot, onWarning);
		return mainRepoContextFile ? join(mainRepoRoot, basename(mainRepoContextFile.path)) : undefined;
	}
	return join(mainRepoRoot, basename(worktreeContextFile.path));
}

interface ProjectContextFileOptions {
	cwd: string;
	agentDir: string;
	projectTrusted?: boolean;
}

function contextAgentDirs(agentDir: string): string[] {
	return Array.from(new Set(agentDir === getAgentDir() ? getAgentDirs() : [agentDir])).reverse();
}

function orderContextFiles(
	agentContextFiles: ReadonlyArray<ContextFile | null>,
	ancestorContextFiles: ReadonlyArray<ContextFile | null>,
): ContextFile[] {
	const contextFiles: ContextFile[] = [];
	const seenPaths = new Set<string>();
	for (const contextFile of agentContextFiles) {
		if (contextFile && !seenPaths.has(contextFile.path)) {
			contextFiles.push(contextFile);
			seenPaths.add(contextFile.path);
		}
	}
	const ancestors: ContextFile[] = [];
	for (const contextFile of ancestorContextFiles) {
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestors.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}
	}
	return [...contextFiles, ...ancestors];
}

export function loadProjectContextFiles(options: ProjectContextFileOptions): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const agentContextFiles = contextAgentDirs(resolvePath(options.agentDir)).map((dir) => loadContextFileFromDir(dir));
	if (options.projectTrusted === false) return orderContextFiles(agentContextFiles, []);

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	const ancestorContextFiles = getAncestorDirectories(resolvedCwd).map((currentDir) => {
		const contextFile = loadContextFileFromDir(currentDir);
		// A nested linked worktree's context file and the main repo's selected copy
		// occupy one logical repository scope; skip the main repo's copy so it is not loaded twice.
		// Compare the directory's real path, not the file's, so a symlinked context file is not
		// mistaken for the main repo's copy it points to.
		const isShadowed =
			shadowedContextFile !== undefined &&
			contextFile !== null &&
			samePath(join(realPath(currentDir), basename(contextFile.path)), shadowedContextFile);
		return isShadowed ? null : contextFile;
	});
	return orderContextFiles(agentContextFiles, ancestorContextFiles);
}

export async function loadProjectContextFilesAsync(
	options: ProjectContextFileOptions,
	onWarning: (message: string) => void = emitWarningDefault,
): Promise<ContextFile[]> {
	const resolvedCwd = resolvePath(options.cwd);
	const agentDirs = contextAgentDirs(resolvePath(options.agentDir));
	const agentWarnings = agentDirs.map(() => [] as string[]);
	const agentContextFiles = await Promise.all(
		agentDirs.map((dir, index) => loadContextFileFromDirAsync(dir, (msg) => agentWarnings[index]!.push(msg))),
	);
	for (const warnings of agentWarnings) {
		for (const msg of warnings) onWarning(msg);
	}
	if (options.projectTrusted === false) return orderContextFiles(agentContextFiles, []);

	const shadowWarnings: string[] = [];
	const shadowedContextFile = await findShadowedContextFileAsync(resolvedCwd, (msg) => shadowWarnings.push(msg));
	for (const msg of shadowWarnings) onWarning(msg);

	const ancestorDirs = getAncestorDirectories(resolvedCwd);
	const ancestorWarnings = ancestorDirs.map(() => [] as string[]);
	const ancestorContextFiles = await Promise.all(
		ancestorDirs.map(async (currentDir, index) => {
			const contextFile = await loadContextFileFromDirAsync(currentDir, (msg) => ancestorWarnings[index]!.push(msg));
			const isShadowed =
				shadowedContextFile !== undefined &&
				contextFile !== null &&
				samePath(join(await realPathAsync(currentDir), basename(contextFile.path)), shadowedContextFile);
			return isShadowed ? null : contextFile;
		}),
	);
	for (const warnings of ancestorWarnings) {
		for (const msg of warnings) onWarning(msg);
	}
	return orderContextFiles(agentContextFiles, ancestorContextFiles);
}
