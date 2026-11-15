import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeGitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}
export type WorktreeGitRunner = (cwd: string, args: string[]) => WorktreeGitResult;

function tracked(runGit: WorktreeGitRunner, repo: string, relativePath: string): boolean {
	return runGit(repo, ["ls-files", "--error-unmatch", "--", relativePath]).status === 0;
}
function hasTrackedPathComponent(runGit: WorktreeGitRunner, repo: string, relativePath: string): boolean {
	const components = relativePath.split(/[\\/]+/).filter(Boolean);
	let candidate = "";
	for (const component of components) {
		candidate = candidate ? `${candidate}/${component}` : component;
		const result = runGit(repo, ["ls-files", "--stage", "--", candidate]);
		if (result.stdout.split(/\r?\n/).some((line) => line.slice(line.indexOf("\t") + 1) === candidate)) return true;
	}
	return false;
}
function copySettings(
	runGit: WorktreeGitRunner,
	mainRoot: string,
	worktreeRoot: string,
	relativePath: string,
): boolean {
	const source = path.join(mainRoot, relativePath);
	const destination = path.join(worktreeRoot, relativePath);
	if (
		!fs.existsSync(source) ||
		fs.existsSync(destination) ||
		hasTrackedPathComponent(runGit, worktreeRoot, relativePath)
	)
		return false;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	return true;
}
function configureHooks(runGit: WorktreeGitRunner, mainRoot: string): void {
	const husky = path.join(mainRoot, ".husky");
	const ordinary = path.join(mainRoot, ".git", "hooks");
	let desired: string | undefined;
	try {
		if (fs.statSync(husky).isDirectory()) desired = husky;
	} catch {
		/* continue */
	}
	if (!desired) {
		try {
			if (
				fs
					.readdirSync(ordinary, { withFileTypes: true })
					.some((entry) => entry.isFile() && !entry.name.endsWith(".sample"))
			)
				desired = ordinary;
		} catch {
			/* no hooks */
		}
	}
	if (!desired) return;
	const current = runGit(mainRoot, ["config", "--get", "core.hooksPath"]);
	if (current.status === 0 && path.resolve(mainRoot, current.stdout.trim()) === desired) return;
	const result = runGit(mainRoot, ["config", "core.hooksPath", desired]);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "failed to configure shared core.hooksPath");
}
/** Paths per `git ls-files` call: 100 paths of up to 260 characters stay inside Windows' 32,767-character command line. */
const PATHSPEC_BATCH_SIZE = 100;
/**
 * The paths among `candidates` that git ignores by its standard rules. Only the candidates are listed, as literal
 * pathspecs in batches: listing every ignored file (an installed `node_modules`) can run to many megabytes (#4876).
 */
function ignoredAmong(runGit: WorktreeGitRunner, mainRoot: string, candidates: readonly string[]): string[] {
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
function includedFiles(runGit: WorktreeGitRunner, mainRoot: string): string[] {
	const included = runGit(mainRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"]);
	if (included.status !== 0) throw new Error(`could not list .worktreeinclude files: ${included.stderr.trim()}`);
	return ignoredAmong(runGit, mainRoot, included.stdout.split("\0").filter(Boolean));
}
/**
 * Copy the files `.worktreeinclude` names into the new worktree. When git cannot list them, the worktree is still set
 * up, without them, and a warning saying so is returned (#4876).
 */
function copyIncludes(runGit: WorktreeGitRunner, mainRoot: string, worktreeRoot: string): string | undefined {
	if (!fs.existsSync(path.join(mainRoot, ".worktreeinclude"))) return undefined;
	let files: string[];
	try {
		files = includedFiles(runGit, mainRoot);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `.worktreeinclude files were not copied into ${worktreeRoot}: ${reason}`;
	}
	for (const relativePath of files) {
		if (hasTrackedPathComponent(runGit, worktreeRoot, relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		try {
			if (!fs.statSync(source).isFile() || fs.existsSync(destination)) continue;
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(source, destination);
		} catch {
			/* concurrent removal */
		}
	}
	return undefined;
}
/**
 * Set up a new worktree and return the synthetic paths it created. A step that could not be done but is not needed to
 * work in the worktree adds a message to `warnings` instead of failing the setup.
 */
export function performPostCreationSetup(
	runGit: WorktreeGitRunner,
	mainRoot: string,
	worktreeRoot: string,
	warnings: string[] = [],
): string[] {
	const synthetic: string[] = [];
	if (copySettings(runGit, mainRoot, worktreeRoot, ".atomic/settings.local.json"))
		synthetic.push(".atomic/settings.local.json");
	if (
		!tracked(runGit, mainRoot, ".atomic/settings.json") &&
		copySettings(runGit, mainRoot, worktreeRoot, ".atomic/settings.json")
	) {
		synthetic.push(".atomic/settings.json");
	}
	configureHooks(runGit, mainRoot);
	const source = path.join(mainRoot, "node_modules");
	const destination = path.join(worktreeRoot, "node_modules");
	if (fs.existsSync(source) && !fs.existsSync(destination) && !tracked(runGit, worktreeRoot, "node_modules")) {
		try {
			fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : undefined);
			synthetic.push("node_modules");
		} catch {
			/* optional */
		}
	}
	const includeWarning = copyIncludes(runGit, mainRoot, worktreeRoot);
	if (includeWarning !== undefined) warnings.push(includeWarning);
	return synthetic;
}
