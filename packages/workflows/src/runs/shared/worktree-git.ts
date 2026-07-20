import * as fs from "node:fs";
import * as path from "node:path";
import type { GitResult, GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./worktree-types.js";
import { openGitWorktreeGenerationAnchor, type GitWorktreeGenerationAnchor } from "./worktree-generation.js";
import { findCanonicalGitRoot } from "./worktree-root.js";
import {
	gitFailureMessage,
	isGitTimeoutResult,
	runGit,
	runGitReadOnlyProbe,
} from "./worktree-git-runner.js";

export {
	gitFailureMessage,
	isGitTimeoutResult,
	runGit,
	runGitChecked,
	runGitPlain,
	withGitRunnerForTest,
} from "./worktree-git-runner.js";
export type { GitRunner } from "./worktree-git-runner.js";

export interface GitWorktreeSetupCache {
	get(options: GitWorktreeSetupOptions): GitWorktreeSetupResult;
	dispose(): void;
}

function gitWorktreeSetupCacheKey(options: GitWorktreeSetupOptions): string {
	const repoRoot = repositoryRootForGitWorktree(options.cwd);
	const { logicalRepoRoot } = cwdWithinGitRepository(options.cwd, repoRoot);
	const worktreeRoot = resolveGitWorktreePath(options.gitWorktreeDir, logicalRepoRoot);
	return JSON.stringify([
		comparableRealPath(gitCommonDirForWorktree(repoRoot)),
		comparablePathThroughExistingAncestor(worktreeRoot),
	]);
}

interface CachedGitWorktreeSetup {
	readonly result: GitWorktreeSetupResult;
	readonly identity: GitWorktreeIdentity;
}

export function createGitWorktreeSetupCache(): GitWorktreeSetupCache {
	const results = new Map<string, CachedGitWorktreeSetup>();
	let disposed = false;
	return {
		get(options) {
			if (disposed) throw new Error("Git worktree setup cache is already disposed");
			const key = gitWorktreeSetupCacheKey(options);
			const cached = results.get(key);
			if (cached !== undefined) {
				assertCachedGitWorktreeIdentity(cached, options);
				return cached.result;
			}
			const result = setupGitWorktree(options);
			results.set(key, { result, identity: captureGitWorktreeIdentity(result) });
			return result;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			let firstError: Error | undefined;
			for (const cached of results.values()) {
				try {
					cached.identity.generation.dispose();
				} catch (error) {
					firstError ??= error instanceof Error ? error : new Error(String(error));
				}
			}
			results.clear();
			if (firstError !== undefined) throw firstError;
		},
	};
}

export function setupGitWorktreeCached(options: GitWorktreeSetupOptions, cache?: GitWorktreeSetupCache): GitWorktreeSetupResult {
	return cache?.get(options) ?? setupGitWorktree(options);
}

function quoteShellArg(value: string): string {
	if (process.platform === "win32") return `"${value.replace(/"/g, "\"\"")}"`;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function worktreeRecoveryCommand(repositoryRoot: string, worktreeDir: string): string {
	return `git -C ${quoteShellArg(repositoryRoot)} worktree remove --force ${quoteShellArg(worktreeDir)}`;
}

function hasGrandparent(value: string): boolean {
	const parent = path.dirname(value);
	if (parent === value) return false;
	const grandparent = path.dirname(parent);
	return grandparent !== parent;
}

function pathAncestors(value: string): string[] {
	const ancestors: string[] = [];
	let current = value;
	while (true) {
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) return ancestors;
		current = parent;
	}
}

function shouldPreserveLogicalPath(logicalPath: string): boolean {
	return pathAncestors(logicalPath).some((ancestor) => {
		try {
			return fs.lstatSync(ancestor).isSymbolicLink() && hasGrandparent(ancestor);
		} catch {
			return false;
		}
	});
}

function canonicalizePreservingSymlinks(value: string): string {
	const logicalPath = path.resolve(value);
	const preserveLogicalPath = shouldPreserveLogicalPath(logicalPath);
	try {
		const canonical = fs.realpathSync.native(logicalPath);
		return preserveLogicalPath && canonical !== logicalPath ? logicalPath : canonical;
	} catch {
		return logicalPath;
	}
}

function resolveGitWorktreePath(value: string, repoRoot: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("gitWorktreeDir cannot be empty");
	if (trimmed.includes("\0")) {
		throw new Error("gitWorktreeDir contains an unusable null byte; provide a valid path or omit gitWorktreeDir.");
	}
	return canonicalizePreservingSymlinks(path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed));
}

function comparableRealPath(value: string): string {
	const realpath = fs.realpathSync.native(value).replace(/\\/g, "/");
	return process.platform === "win32" ? realpath.toLowerCase() : realpath;
}

function comparablePathThroughExistingAncestor(value: string): string {
	let existing = path.resolve(value);
	const missing: string[] = [];
	while (!pathExistsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	const resolved = path.resolve(comparableRealPath(existing), ...missing).replace(/\\/g, "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function validateWorktreeOutsideInvokingCheckout(worktreeRoot: string, repoRoot: string): void {
	const repository = comparableRealPath(repoRoot);
	const candidate = comparablePathThroughExistingAncestor(worktreeRoot);
	const relativePath = path.relative(repository, candidate);
	if (relativePath === "") {
		throw new Error("gitWorktreeDir must not resolve to the invoking checkout; provide a separate same-repository worktree path.");
	}
	if (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath)) {
		throw new Error("gitWorktreeDir must be outside the invoking checkout; provide a separate same-repository worktree path.");
	}
}

function gitPathFromOutput(value: string, cwd: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

function pathExistsSync(value: string): boolean {
	try {
		fs.statSync(value);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

function repositoryRootForGitWorktree(cwd: string): string {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) {
		if (isGitTimeoutResult(result)) {
			throw new Error(`Timed out while checking the Git repository for gitWorktreeDir from ${cwd}. Git reported: ${gitFailureMessage(result)}`);
		}
		throw new Error(`gitWorktreeDir requires the workflow to be invoked from inside a Git repository. Start from a Git checkout or omit gitWorktreeDir. Git reported: ${gitFailureMessage(result)}`);
	}
	return result.stdout.trim();
}

export function gitTopLevelFromResult(result: GitResult, cwd: string, description: string): string | undefined {
	if (result.status !== 0) {
		if (isGitTimeoutResult(result)) {
			throw new Error(`Timed out while validating ${description}. Git reported: ${gitFailureMessage(result)}`);
		}
		return undefined;
	}
	return gitPathFromOutput(result.stdout, cwd);
}

function gitTopLevel(cwd: string): string | undefined {
	return gitTopLevelFromResult(runGitReadOnlyProbe(cwd, ["rev-parse", "--show-toplevel"]), cwd, `gitWorktreeDir ${cwd}`);
}

function gitCommonDirForWorktree(cwd: string): string {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--git-common-dir"]);
	if (result.status !== 0) {
		if (isGitTimeoutResult(result)) {
			throw new Error(`Timed out while validating Git common directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`);
		}
		throw new Error(`Failed to validate Git common directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`);
	}
	const gitPath = gitPathFromOutput(result.stdout, cwd);
	if (gitPath === undefined) throw new Error("git rev-parse --git-common-dir returned an empty path");
	return gitPath;
}

function dirnameForEachRelativeComponent(base: string, relativePath: string): string | undefined {
	if (relativePath === "") return base;
	let current = base;
	for (const component of relativePath.split(/[\\/]+/).filter(Boolean)) {
		if (component === ".") continue;
		if (component === "..") return undefined;
		current = path.dirname(current);
	}
	return current;
}

function cwdWithinGitRepository(cwd: string, repoRoot: string): { relativeCwd: string; logicalRepoRoot: string } {
	const sourceCwd = fs.realpathSync.native(cwd);
	const sourceRepoRoot = fs.realpathSync.native(repoRoot);
	const relativeCwd = path.relative(sourceRepoRoot, sourceCwd);
	const safeRelativeCwd = relativeCwd === "" || relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd) ? "" : relativeCwd;
	const logicalCwd = canonicalizePreservingSymlinks(cwd);
	return {
		relativeCwd: safeRelativeCwd,
		logicalRepoRoot: dirnameForEachRelativeComponent(logicalCwd, safeRelativeCwd) ?? repoRoot,
	};
}

function workspaceCwdForGitWorktreeRoot(worktreeRoot: string, relativeCwd: string): string {
	return relativeCwd === "" ? worktreeRoot : path.join(worktreeRoot, relativeCwd);
}

function validateExistingGitWorktreeRoot(worktreeRoot: string, repoRoot: string): void {
	const topLevel = gitTopLevel(worktreeRoot);
	if (topLevel === undefined) {
		throw new Error(`gitWorktreeDir already exists but is not a Git worktree: ${worktreeRoot}`);
	}
	if (comparableRealPath(worktreeRoot) !== comparableRealPath(topLevel)) {
		throw new Error(`gitWorktreeDir already exists but is not a Git worktree root: ${worktreeRoot}. Git top-level checkout is ${topLevel}`);
	}
	if (comparableRealPath(gitCommonDirForWorktree(repoRoot)) !== comparableRealPath(gitCommonDirForWorktree(topLevel))) {
		throw new Error(`gitWorktreeDir already exists but does not belong to the invoking Git repository: ${worktreeRoot}`);
	}
}

interface GitWorktreeIdentitySnapshot {
	readonly worktreeRealPath: string;
	readonly repositoryRealPath: string;
	readonly gitDirRealPath: string;
	readonly commonDirRealPath: string;
	readonly device: number;
	readonly inode: number;
}

interface GitWorktreeIdentity extends GitWorktreeIdentitySnapshot {
	readonly generation: GitWorktreeGenerationAnchor;
}

function gitDirectoryForWorktree(cwd: string): string {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--absolute-git-dir"]);
	if (result.status !== 0) {
		throw new Error(`Failed to validate Git directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`);
	}
	const gitDir = gitPathFromOutput(result.stdout, cwd);
	if (gitDir === undefined) throw new Error("git rev-parse --absolute-git-dir returned an empty path");
	return gitDir;
}
function captureGitWorktreeIdentitySnapshot(setup: GitWorktreeSetupResult): GitWorktreeIdentitySnapshot {
	validateWorktreeOutsideInvokingCheckout(setup.worktreeRoot, setup.repositoryRoot);
	validateExistingGitWorktreeRoot(setup.worktreeRoot, setup.repositoryRoot);
	const stats = fs.statSync(setup.worktreeRoot);
	return {
		worktreeRealPath: comparableRealPath(setup.worktreeRoot),
		repositoryRealPath: comparableRealPath(setup.repositoryRoot),
		gitDirRealPath: comparableRealPath(gitDirectoryForWorktree(setup.worktreeRoot)),
		commonDirRealPath: comparableRealPath(gitCommonDirForWorktree(setup.worktreeRoot)),
		device: stats.dev,
		inode: stats.ino,
	};
}

function captureGitWorktreeIdentity(setup: GitWorktreeSetupResult): GitWorktreeIdentity {
	const snapshot = captureGitWorktreeIdentitySnapshot(setup);
	return { ...snapshot, generation: openGitWorktreeGenerationAnchor(setup.worktreeRoot) };
}

function assertCachedGitWorktreeIdentity(cached: CachedGitWorktreeSetup, options: GitWorktreeSetupOptions): void {
	let current: GitWorktreeIdentitySnapshot;
	try {
		current = captureGitWorktreeIdentitySnapshot(cached.result);
		cached.identity.generation.assertCurrent();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cached gitWorktreeDir changed before reuse: ${options.gitWorktreeDir}. Reason: ${message}`);
	}
	const expected = cached.identity;
	if (
		current.worktreeRealPath !== expected.worktreeRealPath ||
		current.repositoryRealPath !== expected.repositoryRealPath ||
		current.gitDirRealPath !== expected.gitDirRealPath ||
		current.commonDirRealPath !== expected.commonDirRealPath ||
		current.device !== expected.device ||
		current.inode !== expected.inode
	) {
		throw new Error(`Cached gitWorktreeDir changed before reuse: ${options.gitWorktreeDir}. Start a new run with the intended same-repository worktree.`);
	}
}

export function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult {
	const repoRoot = repositoryRootForGitWorktree(options.cwd);
	const mainRoot = findCanonicalGitRoot(repoRoot);
	if (mainRoot === undefined) {
		throw new Error(`Unable to resolve the canonical main Git repository root from ${repoRoot}.`);
	}
	const { relativeCwd, logicalRepoRoot } = cwdWithinGitRepository(options.cwd, repoRoot);
	const worktreeRoot = resolveGitWorktreePath(options.gitWorktreeDir, logicalRepoRoot);
	validateWorktreeOutsideInvokingCheckout(worktreeRoot, repoRoot);
	if (pathExistsSync(worktreeRoot)) {
		validateExistingGitWorktreeRoot(worktreeRoot, repoRoot);
		return {
			worktreeRoot,
			cwd: workspaceCwdForGitWorktreeRoot(worktreeRoot, relativeCwd),
			repositoryRoot: repoRoot,
			created: false,
		};
	}

	try {
		fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to create parent directory for requested gitWorktreeDir ${worktreeRoot}: ${message}`);
	}
	const baseRef = options.baseBranch?.trim() || "HEAD";
	const result = runGit(mainRoot, ["worktree", "add", "--detach", worktreeRoot, baseRef]);
	if (result.status !== 0) {
		throw new Error([
			`Failed to create git worktree at requested gitWorktreeDir ${worktreeRoot} from ${baseRef}. Git reported: ${gitFailureMessage(result)}`,
			`If another process just created this same-repository worktree, rerun the workflow to resume it. If this is an orphaned worktree from an interrupted run, recover or remove it with: ${worktreeRecoveryCommand(mainRoot, worktreeRoot)}`,
		].join("\n"));
	}
	try {
		validateWorktreeOutsideInvokingCheckout(worktreeRoot, repoRoot);
		validateExistingGitWorktreeRoot(worktreeRoot, repoRoot);
	} catch (error) {
		// Best-effort rollback of a target that changed while Git was creating it.
		runGit(mainRoot, ["worktree", "remove", "--force", worktreeRoot]);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Created gitWorktreeDir failed post-creation validation: ${message}`);
	}
	return {
		worktreeRoot,
		cwd: workspaceCwdForGitWorktreeRoot(worktreeRoot, relativeCwd),
		repositoryRoot: repoRoot,
		created: true,
	};
}
