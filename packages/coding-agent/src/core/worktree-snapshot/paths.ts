import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { resolvePhysicalPath, resolvePhysicalPathAsync } from "../../utils/physical-path.ts";
import { sha256Hex } from "./env-hash.ts";
import { unreadablePathError, WorkspaceRestoreError } from "./errors.ts";

export function defaultWorktreeSnapshotStoreDir(): string {
	return join(getAgentDir(), "worktree-snapshots");
}

/**
 * The private index captures of one checkout keep between turns, under the restore store and never inside the
 * repository: one file per Git directory and work tree root, so a moved checkout gets a new one.
 */
export function captureIndexPath(storeDir: string, gitDir: string, root: string): string {
	return join(storeDir, "capture-index", sha256Hex(`${gitDir}\0${root}`).slice(0, 24));
}

/**
 * `path` with every symbolic link on it resolved, dangling ones included: the real path of its deepest existing
 * ancestor, with the components below it appended unchanged. Snapshot roots are Git's physical top levels, so a working directory
 * reached through a link compares and maps against them only in this form, and a checkout that no longer exists still
 * maps by its spelling. A component that exists but cannot be resolved fails with `unreadable-path`.
 */
export function canonicalizeWorktreePath(path: string): string {
	const absolute = resolve(path);
	try {
		return resolvePhysicalPath(absolute);
	} catch (error) {
		throw unreadablePathError(absolute, error);
	}
}

/** {@link canonicalizeWorktreePath} without blocking the event loop. */
export async function canonicalizeWorktreePathAsync(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await resolvePhysicalPathAsync(absolute);
	} catch (error) {
		throw unreadablePathError(absolute, error);
	}
}

/**
 * The name of the staging worktree a restore checks out before moving it into place: `.s-` and 12 hex digits of the
 * restore's id. Git names the worktree's administrative directory after it, and that directory keeps the name after the
 * move, so a short name keeps every pooled worktree's Git files and writer lease shorter on Windows (#5139). Earlier
 * versions named it `.staging-<id>`; their crash records still name that and are still cleaned.
 */
export function stagingWorktreeName(id: string): string {
	return `.s-${id.replaceAll("-", "").slice(0, 12)}`;
}

/** Longest `GIT_DIR` Git for Windows accepts, as the object store a restore runs Git in: longer is "'$GIT_DIR' too big" (#5139). */
export const WINDOWS_GIT_DIR_LIMIT = 220;
/** Longest worktree root Git for Windows accepts: longer, `git worktree add` fails with "'$GIT_DIR' too big" (#5139). */
export const WINDOWS_WORKTREE_ROOT_LIMIT = 212;
/** Longest administrative directory, `<store>/worktrees/<name>`, Git for Windows can create and read back (#5139). */
export const WINDOWS_WORKTREE_GIT_DIR_LIMIT = 247;

/** The directory Git keeps a worktree's files in when it adds the worktree at `root` to `store`. */
export function worktreeGitDir(store: string, root: string): string {
	return join(store, "worktrees", basename(root).replace(/^\./, "-"));
}

export interface RestorePathBudget {
	readonly storeDir: string;
	/** The object store the restore checks out of; called only on Windows, and a failure to name it skips the check. */
	readonly store: () => string;
	/** The staging worktree the restore checks out first. Git names the worktree's own directory after it. */
	readonly staging: string;
	/** Where the restore moves the staging worktree. */
	readonly target: string;
	readonly snapshotId: string | null;
	readonly platform?: NodeJS.Platform;
}

/**
 * Fails a restore on Windows before it writes anything when a path it would create is longer than Git for Windows
 * accepts even with `core.longpaths`: the object store, the staging worktree's or the target's root, or the directory Git keeps the
 * worktree's own files in, named after the staging worktree and kept after the move. The error names the agent
 * directory, whose depth sets these lengths, or `storeDir` when the restore was given one elsewhere. Atomic opens its
 * own files there in long-path forms, so these are the paths that bound it (#5139). A store that cannot be named is
 * not checked: the restore fails where it needs it, as on every other platform.
 */
export function assertRestorePathBudget(budget: RestorePathBudget): void {
	if ((budget.platform ?? process.platform) !== "win32") return;
	let store: string;
	try {
		store = budget.store();
	} catch {
		return;
	}
	const checks = [
		{ path: store, limit: WINDOWS_GIT_DIR_LIMIT },
		{ path: budget.staging, limit: WINDOWS_WORKTREE_ROOT_LIMIT },
		{ path: budget.target, limit: WINDOWS_WORKTREE_ROOT_LIMIT },
		{ path: worktreeGitDir(store, budget.staging), limit: WINDOWS_WORKTREE_GIT_DIR_LIMIT },
	];
	const over = checks.find((check) => check.path.length > check.limit);
	if (over === undefined) return;
	const agentDir = resolve(getAgentDir());
	const storeDir = resolve(budget.storeDir);
	throw new WorkspaceRestoreError("path-too-long", {
		snapshotId: budget.snapshotId,
		target: over.path,
		limit: over.limit,
		agentDir: dirname(storeDir) === agentDir ? agentDir : storeDir,
	});
}
