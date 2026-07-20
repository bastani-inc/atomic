import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeGitResult { stdout: string; stderr: string; status: number | null }
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
function copySettings(runGit: WorktreeGitRunner, mainRoot: string, worktreeRoot: string, relativePath: string): boolean {
	const source = path.join(mainRoot, relativePath);
	const destination = path.join(worktreeRoot, relativePath);
	if (!fs.existsSync(source) || fs.existsSync(destination) || hasTrackedPathComponent(runGit, worktreeRoot, relativePath)) return false;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	return true;
}
function configureHooks(runGit: WorktreeGitRunner, mainRoot: string): void {
	const husky = path.join(mainRoot, ".husky");
	const ordinary = path.join(mainRoot, ".git", "hooks");
	let desired: string | undefined;
	try { if (fs.statSync(husky).isDirectory()) desired = husky; } catch { /* continue */ }
	if (!desired) {
		try {
			if (fs.readdirSync(ordinary, { withFileTypes: true }).some((entry) => entry.isFile() && !entry.name.endsWith(".sample"))) desired = ordinary;
		} catch { /* no hooks */ }
	}
	if (!desired) return;
	const current = runGit(mainRoot, ["config", "--get", "core.hooksPath"]);
	if (current.status === 0 && path.resolve(mainRoot, current.stdout.trim()) === desired) return;
	const result = runGit(mainRoot, ["config", "core.hooksPath", desired]);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "failed to configure shared core.hooksPath");
}
function copyIncludes(runGit: WorktreeGitRunner, mainRoot: string, worktreeRoot: string): void {
	if (!fs.existsSync(path.join(mainRoot, ".worktreeinclude"))) return;
	const ignored = runGit(mainRoot, ["ls-files", "--others", "--ignored", "--exclude-standard"]);
	const included = runGit(mainRoot, ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude"]);
	if (ignored.status !== 0 || included.status !== 0) return;
	const ignoredPaths = new Set(ignored.stdout.split(/\r?\n/).filter(Boolean));
	for (const relativePath of included.stdout.split(/\r?\n/).filter(Boolean)) {
		if (!ignoredPaths.has(relativePath) || hasTrackedPathComponent(runGit, worktreeRoot, relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = path.join(worktreeRoot, relativePath);
		try {
			if (!fs.statSync(source).isFile() || fs.existsSync(destination)) continue;
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(source, destination);
		} catch { /* concurrent removal */ }
	}
}
export function performPostCreationSetup(runGit: WorktreeGitRunner, mainRoot: string, worktreeRoot: string): string[] {
	const synthetic: string[] = [];
	if (copySettings(runGit, mainRoot, worktreeRoot, ".atomic/settings.local.json")) synthetic.push(".atomic/settings.local.json");
	if (!tracked(runGit, mainRoot, ".atomic/settings.json") && copySettings(runGit, mainRoot, worktreeRoot, ".atomic/settings.json")) {
		synthetic.push(".atomic/settings.json");
	}
	configureHooks(runGit, mainRoot);
	const source = path.join(mainRoot, "node_modules");
	const destination = path.join(worktreeRoot, "node_modules");
	if (fs.existsSync(source) && !fs.existsSync(destination) && !tracked(runGit, worktreeRoot, "node_modules")) {
		try { fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : undefined); synthetic.push("node_modules"); } catch { /* optional */ }
	}
	copyIncludes(runGit, mainRoot, worktreeRoot);
	return synthetic;
}
