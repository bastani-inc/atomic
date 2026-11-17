import { copyFile, mkdir, readdir, stat, symlink } from "node:fs/promises";
import * as path from "node:path";
import { pathExists } from "../../shared/path-exists.js";
import { runGit, runGitPlain } from "./worktree-git.js";

async function tracked(repo: string, relativePath: string): Promise<boolean> {
	const result = await runGit(repo, ["ls-files", "--error-unmatch", "--", relativePath]);
	return result.status === 0;
}

async function hasTrackedPathComponent(repo: string, relativePath: string): Promise<boolean> {
	const components = relativePath.split(/[\\/]+/).filter(Boolean);
	let candidate = "";
	for (const component of components) {
		candidate = candidate ? `${candidate}/${component}` : component;
		const result = await runGit(repo, ["ls-files", "--stage", "--", candidate]);
		if (result.status !== 0) continue;
		const exact = result.stdout.split(/\r?\n/).some((line) => line.slice(line.indexOf("\t") + 1) === candidate);
		if (exact) return true;
	}
	return false;
}

async function copyUntrackedFile(mainRoot: string, worktreeRoot: string, relativePath: string): Promise<boolean> {
	const source = path.join(mainRoot, relativePath);
	const destination = path.join(worktreeRoot, relativePath);
	if (
		!(await pathExists(source)) ||
		(await pathExists(destination)) ||
		(await hasTrackedPathComponent(worktreeRoot, relativePath))
	)
		return false;
	await mkdir(path.dirname(destination), { recursive: true });
	await copyFile(source, destination);
	return true;
}

async function propagateLocalSettings(mainRoot: string, worktreeRoot: string): Promise<string[]> {
	const copied: string[] = [];
	if (await copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.local.json"))
		copied.push(".atomic/settings.local.json");
	if (
		!(await tracked(mainRoot, ".atomic/settings.json")) &&
		(await copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.json"))
	) {
		copied.push(".atomic/settings.json");
	}
	return copied;
}

async function populatedHooksDirectory(mainRoot: string): Promise<string | undefined> {
	const husky = path.join(mainRoot, ".husky");
	try {
		if ((await stat(husky)).isDirectory()) return husky;
	} catch {
		// Try ordinary Git hooks.
	}
	const hooks = path.join(mainRoot, ".git", "hooks");
	try {
		const populated = (await readdir(hooks, { withFileTypes: true })).some(
			(entry) => entry.isFile() && !entry.name.endsWith(".sample"),
		);
		return populated ? hooks : undefined;
	} catch {
		return undefined;
	}
}

async function configureSharedHooksPath(mainRoot: string): Promise<void> {
	const desired = await populatedHooksDirectory(mainRoot);
	if (desired === undefined) return;
	const current = await runGitPlain(mainRoot, ["config", "--get", "core.hooksPath"]);
	if (current.status === 0 && path.resolve(mainRoot, current.stdout.trim()) === desired) return;
	const configured = await runGitPlain(mainRoot, ["config", "core.hooksPath", desired]);
	if (configured.status !== 0) {
		throw new Error(configured.stderr.trim() || "failed to configure shared core.hooksPath");
	}
}

function normalizeSymlinkDirectory(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || path.isAbsolute(trimmed)) return undefined;
	const normalized = path.normalize(trimmed);
	if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined;
	return normalized;
}

async function symlinkConfiguredDirectories(
	mainRoot: string,
	worktreeRoot: string,
	directories: readonly string[],
): Promise<string[]> {
	const synthetic: string[] = [];
	for (const rawDirectory of directories) {
		const relativePath = normalizeSymlinkDirectory(rawDirectory);
		if (relativePath === undefined || synthetic.includes(relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		if (
			!(await pathExists(source)) ||
			(await pathExists(destination)) ||
			(await hasTrackedPathComponent(worktreeRoot, relativePath))
		)
			continue;
		await mkdir(path.dirname(destination), { recursive: true });
		try {
			await symlink(source, destination, process.platform === "win32" ? "junction" : undefined);
			synthetic.push(relativePath);
		} catch {
			// Optional setup: unsupported filesystems may reject symlinks.
		}
	}
	return synthetic;
}

/** Paths per `git ls-files` call: 100 paths of up to 260 characters stay inside Windows' 32,767-character command line. */
const PATHSPEC_BATCH_SIZE = 100;
/**
 * The paths among `candidates` that git ignores by its standard rules. Only the candidates are listed, as literal
 * pathspecs in batches: listing every ignored file (an installed `node_modules`) can run to many megabytes (#4876).
 */
async function ignoredAmong(mainRoot: string, candidates: readonly string[]): Promise<string[]> {
	const ignored: string[] = [];
	for (let start = 0; start < candidates.length; start += PATHSPEC_BATCH_SIZE) {
		const batch = candidates.slice(start, start + PATHSPEC_BATCH_SIZE);
		const args = ["--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"];
		const listed = await runGit(mainRoot, [...args, ...batch]);
		if (listed.status !== 0)
			throw new Error(`could not list ignored .worktreeinclude files: ${listed.stderr.trim()}`);
		ignored.push(...listed.stdout.split("\0").filter(Boolean));
	}
	return ignored;
}
/** The ignored files `.worktreeinclude` names, which a new worktree gets a copy of. */
async function includedFiles(mainRoot: string): Promise<string[]> {
	const included = await runGit(mainRoot, [
		"ls-files",
		"-z",
		"--others",
		"--ignored",
		"--exclude-from=.worktreeinclude",
	]);
	if (included.status !== 0) throw new Error(`could not list .worktreeinclude files: ${included.stderr.trim()}`);
	return ignoredAmong(mainRoot, included.stdout.split("\0").filter(Boolean));
}
/**
 * Copy the files `.worktreeinclude` names into the new worktree. When git cannot list them, the worktree is still set
 * up, without them, and a warning saying so is returned (#4876).
 */
async function copyWorktreeIncludes(mainRoot: string, worktreeRoot: string): Promise<string | undefined> {
	if (!(await pathExists(path.join(mainRoot, ".worktreeinclude")))) return undefined;
	let files: string[];
	try {
		files = await includedFiles(mainRoot);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `.worktreeinclude files were not copied into ${worktreeRoot}: ${reason}`;
	}
	for (const relativePath of files) {
		if (await hasTrackedPathComponent(worktreeRoot, relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		try {
			if (!(await stat(source)).isFile() || (await pathExists(destination))) continue;
			await mkdir(path.dirname(destination), { recursive: true });
			await copyFile(source, destination);
		} catch {
			// A concurrently removed ignored file is harmless.
		}
	}
	return undefined;
}

/**
 * Set up a new worktree and return the synthetic paths it created. A step that could not be done but is not needed to
 * work in the worktree adds a message to `warnings` instead of failing the setup.
 */
export async function performPostCreationSetup(
	mainRoot: string,
	worktreeRoot: string,
	symlinkDirectories: readonly string[],
	warnings: string[] = [],
): Promise<string[]> {
	const syntheticPaths = await propagateLocalSettings(mainRoot, worktreeRoot);
	await configureSharedHooksPath(mainRoot);
	syntheticPaths.push(...(await symlinkConfiguredDirectories(mainRoot, worktreeRoot, symlinkDirectories)));
	const includeWarning = await copyWorktreeIncludes(mainRoot, worktreeRoot);
	if (includeWarning !== undefined) warnings.push(includeWarning);
	return syntheticPaths;
}
