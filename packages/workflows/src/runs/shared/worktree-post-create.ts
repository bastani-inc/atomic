import * as fs from "node:fs";
import * as path from "node:path";
import { runGit, runGitPlain } from "./worktree-git.js";

function tracked(repo: string, relativePath: string): boolean {
	const result = runGit(repo, ["ls-files", "--error-unmatch", "--", relativePath]);
	return result.status === 0;
}

function hasTrackedPathComponent(repo: string, relativePath: string): boolean {
	const components = relativePath.split(/[\\/]+/).filter(Boolean);
	let candidate = "";
	for (const component of components) {
		candidate = candidate ? `${candidate}/${component}` : component;
		const result = runGit(repo, ["ls-files", "--stage", "--", candidate]);
		if (result.status !== 0) continue;
		const exact = result.stdout.split(/\r?\n/).some((line) => line.slice(line.indexOf("\t") + 1) === candidate);
		if (exact) return true;
	}
	return false;
}

function copyUntrackedFile(mainRoot: string, worktreeRoot: string, relativePath: string): boolean {
	const source = path.join(mainRoot, relativePath);
	const destination = path.join(worktreeRoot, relativePath);
	if (!fs.existsSync(source) || fs.existsSync(destination) || hasTrackedPathComponent(worktreeRoot, relativePath))
		return false;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	return true;
}

function propagateLocalSettings(mainRoot: string, worktreeRoot: string): string[] {
	const copied: string[] = [];
	if (copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.local.json"))
		copied.push(".atomic/settings.local.json");
	if (
		!tracked(mainRoot, ".atomic/settings.json") &&
		copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.json")
	) {
		copied.push(".atomic/settings.json");
	}
	return copied;
}

function populatedHooksDirectory(mainRoot: string): string | undefined {
	const husky = path.join(mainRoot, ".husky");
	try {
		if (fs.statSync(husky).isDirectory()) return husky;
	} catch {
		// Try ordinary Git hooks.
	}
	const hooks = path.join(mainRoot, ".git", "hooks");
	try {
		const populated = fs
			.readdirSync(hooks, { withFileTypes: true })
			.some((entry) => entry.isFile() && !entry.name.endsWith(".sample"));
		return populated ? hooks : undefined;
	} catch {
		return undefined;
	}
}

function configureSharedHooksPath(mainRoot: string): void {
	const desired = populatedHooksDirectory(mainRoot);
	if (desired === undefined) return;
	const current = runGitPlain(mainRoot, ["config", "--get", "core.hooksPath"]);
	if (current.status === 0 && path.resolve(mainRoot, current.stdout.trim()) === desired) return;
	const configured = runGitPlain(mainRoot, ["config", "core.hooksPath", desired]);
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

function symlinkConfiguredDirectories(
	mainRoot: string,
	worktreeRoot: string,
	directories: readonly string[],
): string[] {
	const synthetic: string[] = [];
	for (const rawDirectory of directories) {
		const relativePath = normalizeSymlinkDirectory(rawDirectory);
		if (relativePath === undefined || synthetic.includes(relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		if (!fs.existsSync(source) || fs.existsSync(destination) || hasTrackedPathComponent(worktreeRoot, relativePath))
			continue;
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		try {
			fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : undefined);
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
function ignoredAmong(mainRoot: string, candidates: readonly string[]): string[] {
	const ignored: string[] = [];
	for (let start = 0; start < candidates.length; start += PATHSPEC_BATCH_SIZE) {
		const batch = candidates.slice(start, start + PATHSPEC_BATCH_SIZE);
		const args = ["--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"];
		const listed = runGit(mainRoot, [...args, ...batch]);
		if (listed.status !== 0)
			throw new Error(`could not list ignored .worktreeinclude files: ${listed.stderr.trim()}`);
		ignored.push(...listed.stdout.split("\0").filter(Boolean));
	}
	return ignored;
}
/** The ignored files `.worktreeinclude` names, which a new worktree gets a copy of. */
function includedFiles(mainRoot: string): string[] {
	const included = runGit(mainRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"]);
	if (included.status !== 0) throw new Error(`could not list .worktreeinclude files: ${included.stderr.trim()}`);
	return ignoredAmong(mainRoot, included.stdout.split("\0").filter(Boolean));
}
/**
 * Copy the files `.worktreeinclude` names into the new worktree. When git cannot list them, the worktree is still set
 * up, without them, and a warning saying so is returned (#4876).
 */
function copyWorktreeIncludes(mainRoot: string, worktreeRoot: string): string | undefined {
	if (!fs.existsSync(path.join(mainRoot, ".worktreeinclude"))) return undefined;
	let files: string[];
	try {
		files = includedFiles(mainRoot);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `.worktreeinclude files were not copied into ${worktreeRoot}: ${reason}`;
	}
	for (const relativePath of files) {
		if (hasTrackedPathComponent(worktreeRoot, relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		try {
			if (!fs.statSync(source).isFile() || fs.existsSync(destination)) continue;
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(source, destination);
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
export function performPostCreationSetup(
	mainRoot: string,
	worktreeRoot: string,
	symlinkDirectories: readonly string[],
	warnings: string[] = [],
): string[] {
	const syntheticPaths = propagateLocalSettings(mainRoot, worktreeRoot);
	configureSharedHooksPath(mainRoot);
	syntheticPaths.push(...symlinkConfiguredDirectories(mainRoot, worktreeRoot, symlinkDirectories));
	const includeWarning = copyWorktreeIncludes(mainRoot, worktreeRoot);
	if (includeWarning !== undefined) warnings.push(includeWarning);
	return syntheticPaths;
}
