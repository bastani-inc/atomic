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
	if (!fs.existsSync(source) || fs.existsSync(destination) || hasTrackedPathComponent(worktreeRoot, relativePath)) return false;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(source, destination);
	return true;
}

function propagateLocalSettings(mainRoot: string, worktreeRoot: string): string[] {
	const copied: string[] = [];
	if (copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.local.json")) copied.push(".atomic/settings.local.json");
	if (!tracked(mainRoot, ".atomic/settings.json") && copyUntrackedFile(mainRoot, worktreeRoot, ".atomic/settings.json")) {
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
		const populated = fs.readdirSync(hooks, { withFileTypes: true })
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
		if (!fs.existsSync(source) || fs.existsSync(destination) || hasTrackedPathComponent(worktreeRoot, relativePath)) continue;
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

function copyWorktreeIncludes(mainRoot: string, worktreeRoot: string): void {
	if (!fs.existsSync(path.join(mainRoot, ".worktreeinclude"))) return;
	const ignored = runGit(mainRoot, ["ls-files", "--others", "--ignored", "--exclude-standard"]);
	const included = runGit(mainRoot, ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude"]);
	if (ignored.status !== 0 || included.status !== 0) return;
	const ignoredPaths = new Set(ignored.stdout.split(/\r?\n/).filter(Boolean));
	for (const relativePath of included.stdout.split(/\r?\n/).filter(Boolean)) {
		if (!ignoredPaths.has(relativePath) || hasTrackedPathComponent(worktreeRoot, relativePath)) continue;
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
}

export function performPostCreationSetup(
	mainRoot: string,
	worktreeRoot: string,
	symlinkDirectories: readonly string[],
): string[] {
	const syntheticPaths = propagateLocalSettings(mainRoot, worktreeRoot);
	configureSharedHooksPath(mainRoot);
	syntheticPaths.push(...symlinkConfiguredDirectories(mainRoot, worktreeRoot, symlinkDirectories));
	copyWorktreeIncludes(mainRoot, worktreeRoot);
	return syntheticPaths;
}
