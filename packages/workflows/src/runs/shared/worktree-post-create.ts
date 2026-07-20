import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import type { GitResult } from "./worktree-types.js";

type GitRunner = (cwd: string, args: readonly string[]) => GitResult;

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function prepareDestination(root: string, relativePath: string): string {
	const destination = path.resolve(root, relativePath);
	if (!isContained(path.resolve(root), destination)) throw new Error(`worktree setup path escapes its root: ${relativePath}`);
	let ancestor = path.dirname(destination);
	while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
	if (!isContained(fs.realpathSync.native(root), fs.realpathSync.native(ancestor))) {
		throw new Error(`worktree setup path resolves outside its root: ${relativePath}`);
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	return destination;
}

function isUntracked(mainRoot: string, relativePath: string, runGit: GitRunner): boolean {
	return runGit(mainRoot, ["ls-files", "--error-unmatch", "--", relativePath]).status !== 0;
}

function copyUntrackedFile(mainRoot: string, worktreePath: string, relativePath: string, runGit: GitRunner): boolean {
	const source = path.join(mainRoot, relativePath);
	if (!fs.existsSync(source) || !isUntracked(mainRoot, relativePath, runGit)) return false;
	const destination = prepareDestination(worktreePath, relativePath);
	if (fs.existsSync(destination)) return false;
	fs.cpSync(source, destination, { recursive: true });
	return true;
}

function hooksDirectory(mainRoot: string): string | undefined {
	const husky = path.join(mainRoot, ".husky");
	try {
		if (fs.statSync(husky).isDirectory()) return husky;
	} catch {
		// Try native Git hooks.
	}
	const hooks = path.join(mainRoot, ".git", "hooks");
	try {
		const populated = fs.readdirSync(hooks, { withFileTypes: true })
			.some((entry) => !entry.name.endsWith(".sample") && (entry.isFile() || entry.isSymbolicLink()));
		return populated ? hooks : undefined;
	} catch {
		return undefined;
	}
}

function configureSharedHooksPath(mainRoot: string, runGit: GitRunner): void {
	const desired = hooksDirectory(mainRoot);
	if (desired === undefined) return;
	const current = runGit(mainRoot, ["config", "--local", "--get", "core.hooksPath"]);
	if (current.status === 0 && path.resolve(mainRoot, current.stdout.trim()) === desired) return;
	const configured = runGit(mainRoot, ["config", "core.hooksPath", desired]);
	if (configured.status !== 0) throw new Error(configured.stderr.trim() || configured.stdout.trim() || "failed to configure core.hooksPath");
}

function safeRelativeDirectory(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || path.isAbsolute(trimmed)) return undefined;
	const normalized = path.normalize(trimmed);
	return normalized === ".." || normalized.startsWith(`..${path.sep}`) ? undefined : normalized;
}

function symlinkDirectories(mainRoot: string, worktreePath: string, configured: readonly string[]): string[] {
	const linked: string[] = [];
	for (const raw of new Set(["node_modules", ...configured])) {
		const relativePath = safeRelativeDirectory(raw);
		if (relativePath === undefined) continue;
		const source = path.join(mainRoot, relativePath);
		try {
			if (!fs.statSync(source).isDirectory()) continue;
		} catch {
			continue;
		}
		const destination = prepareDestination(worktreePath, relativePath);
		if (fs.existsSync(destination)) continue;
		try {
			fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
			linked.push(relativePath);
		} catch {
			// Directory linking is optional on filesystems that reject symlinks.
		}
	}
	return linked;
}

function copyWorktreeIncludes(mainRoot: string, worktreePath: string, runGit: GitRunner): void {
	const includePath = path.join(mainRoot, ".worktreeinclude");
	if (!fs.existsSync(includePath)) return;
	const matcher = ignore().add(fs.readFileSync(includePath, "utf-8"));
	const ignored = runGit(mainRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
	if (ignored.status !== 0) return;
	for (const relativePath of ignored.stdout.split("\0").filter(Boolean)) {
		if (!matcher.ignores(relativePath)) continue;
		const source = path.join(mainRoot, relativePath);
		const destination = prepareDestination(worktreePath, relativePath);
		if (!fs.existsSync(destination)) fs.cpSync(source, destination, { recursive: true });
	}
}

export function performPostCreationSetup(
	mainRoot: string,
	worktreePath: string,
	configuredSymlinkDirectories: readonly string[],
	runGit: GitRunner,
): string[] {
	const syntheticPaths = symlinkDirectories(mainRoot, worktreePath, configuredSymlinkDirectories);
	for (const relativePath of [".atomic/settings.local.json", ".atomic/settings.json"] as const) {
		if (copyUntrackedFile(mainRoot, worktreePath, relativePath, runGit)) syntheticPaths.push(relativePath);
	}
	configureSharedHooksPath(mainRoot, runGit);
	copyWorktreeIncludes(mainRoot, worktreePath, runGit);
	return syntheticPaths;
}
