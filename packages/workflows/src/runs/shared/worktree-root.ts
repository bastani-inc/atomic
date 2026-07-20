import * as fs from "node:fs";
import * as path from "node:path";

function pathFromPointer(contents: string, prefix: string, base: string): string | undefined {
	if (!contents.startsWith(prefix)) return undefined;
	const value = contents.slice(prefix.length).trim();
	if (!value) return undefined;
	return path.resolve(base, value);
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function samePath(left: string, right: string): boolean {
	try {
		const a = fs.realpathSync.native(left);
		const b = fs.realpathSync.native(right);
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
}

/** Find the nearest checkout root without invoking Git. */
export function findGitRoot(cwd: string): string | undefined {
	let current: string;
	try {
		const resolved = path.resolve(cwd);
		const start = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
		current = fs.realpathSync.native(start);
	} catch {
		return undefined;
	}
	while (true) {
		try {
			const entry = fs.statSync(path.join(current, ".git"));
			if (entry.isDirectory() || entry.isFile()) return current;
		} catch {
			// Continue walking.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Resolve only standard `git worktree add` layouts to their main checkout. */
export function resolveMainRepoRoot(repoRoot: string): string | undefined {
	const gitEntry = path.join(repoRoot, ".git");
	let stats: fs.Stats;
	try {
		stats = fs.statSync(gitEntry);
	} catch {
		return undefined;
	}
	if (stats.isDirectory()) return path.resolve(repoRoot);
	if (!stats.isFile()) return undefined;

	const pointer = readText(gitEntry);
	if (pointer === undefined) return undefined;
	const gitDir = pathFromPointer(pointer, "gitdir:", repoRoot);
	if (gitDir === undefined || path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
	const commonGitDir = path.dirname(path.dirname(gitDir));
	if (path.basename(commonGitDir) !== ".git") return undefined;

	// A real linked-worktree admin directory points back to this checkout and
	// declares the common directory. These checks reject crafted foreign pointers.
	const backPointer = readText(path.join(gitDir, "gitdir"));
	const commonPointer = readText(path.join(gitDir, "commondir"));
	if (backPointer === undefined || commonPointer === undefined) return undefined;
	const linkedGitEntry = path.resolve(gitDir, backPointer.trim());
	const declaredCommonDir = path.resolve(gitDir, commonPointer.trim());
	if (!backPointer.trim() || !commonPointer.trim()) return undefined;
	if (!samePath(linkedGitEntry, gitEntry) || !samePath(declaredCommonDir, commonGitDir)) return undefined;
	return path.dirname(commonGitDir);
}

export function findCanonicalGitRoot(cwd: string): string | undefined {
	const repoRoot = findGitRoot(cwd);
	return repoRoot === undefined ? undefined : resolveMainRepoRoot(repoRoot);
}
