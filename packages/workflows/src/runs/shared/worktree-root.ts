import type { Stats } from "node:fs";
import * as path from "node:path";
import { io, runWorktreeSteps, type WorktreeSteps } from "./worktree-io.js";

function pathFromPointer(contents: string, prefix: string, base: string): string | undefined {
	if (!contents.startsWith(prefix)) return undefined;
	const value = contents.slice(prefix.length).trim();
	if (!value) return undefined;
	return path.resolve(base, value);
}

function* readText(file: string): WorktreeSteps<string | undefined> {
	try {
		return yield* io("readFile", file);
	} catch {
		return undefined;
	}
}

function* samePath(left: string, right: string): WorktreeSteps<boolean> {
	try {
		const a = yield* io("realpath", left);
		const b = yield* io("realpath", right);
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
}

/** Find the nearest checkout root without invoking Git. */
export function* findGitRootSteps(cwd: string): WorktreeSteps<string | undefined> {
	let current = path.resolve(cwd);
	try {
		if (!(yield* io("stat", current)).isDirectory()) current = path.dirname(current);
	} catch {
		return undefined;
	}
	while (true) {
		try {
			const entry = yield* io("stat", path.join(current, ".git"));
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
export function* resolveMainRepoRootSteps(repoRoot: string): WorktreeSteps<string | undefined> {
	const gitEntry = path.join(repoRoot, ".git");
	let stats: Stats;
	try {
		stats = yield* io("stat", gitEntry);
	} catch {
		return undefined;
	}
	if (stats.isDirectory()) return path.resolve(repoRoot);
	if (!stats.isFile()) return undefined;

	const pointer = yield* readText(gitEntry);
	if (pointer === undefined) return undefined;
	const gitDir = pathFromPointer(pointer, "gitdir:", repoRoot);
	if (gitDir === undefined || path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
	const commonGitDir = path.dirname(path.dirname(gitDir));
	if (path.basename(commonGitDir) !== ".git") return undefined;

	// A real linked-worktree admin directory points back to this checkout and
	// declares the common directory. These checks reject crafted foreign pointers.
	const backPointer = yield* readText(path.join(gitDir, "gitdir"));
	const commonPointer = yield* readText(path.join(gitDir, "commondir"));
	if (backPointer === undefined || commonPointer === undefined) return undefined;
	const linkedGitEntry = path.resolve(gitDir, backPointer.trim());
	const declaredCommonDir = path.resolve(gitDir, commonPointer.trim());
	if (!backPointer.trim() || !commonPointer.trim()) return undefined;
	if (!(yield* samePath(linkedGitEntry, gitEntry)) || !(yield* samePath(declaredCommonDir, commonGitDir))) {
		return undefined;
	}
	return path.dirname(commonGitDir);
}

export function* findCanonicalGitRootSteps(cwd: string): WorktreeSteps<string | undefined> {
	const repoRoot = yield* findGitRootSteps(cwd);
	return repoRoot === undefined ? undefined : yield* resolveMainRepoRootSteps(repoRoot);
}

export function findGitRoot(cwd: string): Promise<string | undefined> {
	return runWorktreeSteps(findGitRootSteps(cwd));
}

export function resolveMainRepoRoot(repoRoot: string): Promise<string | undefined> {
	return runWorktreeSteps(resolveMainRepoRootSteps(repoRoot));
}

export function findCanonicalGitRoot(cwd: string): Promise<string | undefined> {
	return runWorktreeSteps(findCanonicalGitRootSteps(cwd));
}

/** The checkout at `cwd` and what its HEAD names: a branch, the reftable placeholder `.invalid`, or nothing. */
function* readGitHeadSteps(cwd: string): WorktreeSteps<{ repoRoot: string; branch: string } | undefined> {
	const repoRoot = yield* findGitRootSteps(cwd);
	if (repoRoot === undefined) return undefined;
	const gitEntry = path.join(repoRoot, ".git");
	let gitDir: string | undefined;
	try {
		const stats = yield* io("stat", gitEntry);
		if (stats.isDirectory()) {
			gitDir = gitEntry;
		} else if (stats.isFile()) {
			const pointer = yield* readText(gitEntry);
			gitDir = pointer === undefined ? undefined : pathFromPointer(pointer, "gitdir:", repoRoot);
		}
	} catch {
		return undefined;
	}
	if (gitDir === undefined) return undefined;
	const head = (yield* readText(path.join(gitDir, "HEAD")))?.trim();
	if (head === undefined || !head.startsWith("ref: refs/heads/")) return undefined;
	const branch = head.slice("ref: refs/heads/".length).trim();
	return branch ? { repoRoot, branch } : undefined;
}

/** The branch checked out at `cwd`, from HEAD; `probeSymbolicRef` asks Git when HEAD names the reftable placeholder. */
export function* resolveGitHeadBranchSteps(
	cwd: string,
	probeSymbolicRef?: (repoRoot: string) => WorktreeSteps<string | undefined>,
): WorktreeSteps<string | undefined> {
	const head = yield* readGitHeadSteps(cwd);
	if (head === undefined) return undefined;
	if (head.branch !== ".invalid") return head.branch;
	if (probeSymbolicRef === undefined) return undefined;
	return (yield* probeSymbolicRef(head.repoRoot))?.trim() || undefined;
}

/** `resolveGitHeadBranchSteps` off the event loop, with a probe that may answer asynchronously. */
export async function resolveGitHeadBranch(
	cwd: string,
	probeSymbolicRef?: (repoRoot: string) => string | undefined | Promise<string | undefined>,
): Promise<string | undefined> {
	const head = await runWorktreeSteps(readGitHeadSteps(cwd));
	if (head === undefined) return undefined;
	if (head.branch !== ".invalid") return head.branch;
	return (await probeSymbolicRef?.(head.repoRoot))?.trim() || undefined;
}
