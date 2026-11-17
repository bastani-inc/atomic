import type { Stats } from "node:fs";
import * as path from "node:path";
import { isPathInside } from "@bastani/atomic";
import {
	allocateWorktreeCheckoutPath,
	bindWorktreeOwner,
	findOwnedWorktreeCheckouts,
	removeEmptyWorktreeBucket,
} from "./worktree-allocation.js";
import { type GitWorktreeGenerationAnchor, openGitWorktreeGenerationAnchor } from "./worktree-generation.js";
import { gitFailureMessage, isGitTimeoutResult } from "./worktree-git-runner.js";
import {
	gitReadOnlyProbeSteps,
	gitSteps,
	io,
	runWorktreeSteps,
	runWorktreeStepsSync,
	type WorktreeSteps,
} from "./worktree-io.js";
import { findCanonicalGitRootSteps, resolveGitHeadBranchSteps } from "./worktree-root.js";
import type { GitResult, GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./worktree-types.js";

/** The branch a run launched at `cwd` records, read without blocking the event loop. */
export function resolveInvocationGitBranch(cwd: string): Promise<string | undefined> {
	return runWorktreeSteps(
		resolveGitHeadBranchSteps(cwd, function* (repoRoot) {
			const result = yield* gitReadOnlyProbeSteps(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
			return result.status === 0 ? result.stdout.trim() : undefined;
		}),
	);
}

export { withWorktreeBucketIdsForTest } from "./worktree-allocation.js";
export type { GitRunner } from "./worktree-git-runner.js";
export {
	gitFailureMessage,
	isGitTimeoutResult,
	runGit,
	runGitChecked,
	runGitPlain,
	withGitRunnerForTest,
} from "./worktree-git-runner.js";

export interface GitWorktreeSetupCache {
	get(options: GitWorktreeSetupOptions): Promise<GitWorktreeSetupResult>;
	dispose(): Promise<void>;
}

/** The Git checkout that contains the workflow's invoking cwd, when there is one. */
interface InvokingRepository {
	/** Checkout top level reported by Git for the invoking cwd. */
	readonly root: string;
	/** Logical spelling of `root`, preserving symlinks in the invoking cwd. */
	readonly logicalRoot: string;
	/** Invoking cwd relative to `root`; empty at the top level. */
	readonly relativeCwd: string;
}

interface GitWorktreeSetupRequest {
	readonly options: GitWorktreeSetupOptions;
	readonly repository?: InvokingRepository;
	/** Why the invoking cwd is not inside a Git checkout, when it is not. */
	readonly repositoryProbeFailure?: string;
	/** Absolute requested gitWorktreeDir. */
	readonly target: string;
}

interface ResolvedGitWorktreeSetup {
	readonly result: GitWorktreeSetupResult;
	/** Invoking checkout that the selected worktree must stay outside of. */
	readonly invokingRoot?: string;
}

interface CachedGitWorktreeSetup extends ResolvedGitWorktreeSetup {
	readonly identity: GitWorktreeIdentity;
}

function* gitWorktreeSetupCacheKey(request: GitWorktreeSetupRequest): WorktreeSteps<string> {
	return JSON.stringify([
		yield* comparablePathThroughExistingAncestor(request.options.cwd),
		yield* comparablePathThroughExistingAncestor(request.target),
	]);
}

/**
 * Create a setup cache for one workflow run. `ownerRunId` identifies the run that
 * owns checkouts allocated under a non-empty gitWorktreeDir, so resuming the same
 * run finds its checkout again instead of allocating another one.
 */
export function createGitWorktreeSetupCache(ownerRunId?: string): GitWorktreeSetupCache {
	const results = new Map<string, Promise<CachedGitWorktreeSetup>>();
	let disposed = false;
	const assertOpen = (): void => {
		if (disposed) throw new Error("Git worktree setup cache is already disposed");
	};
	return {
		async get(options) {
			assertOpen();
			const request = await runWorktreeSteps(resolveGitWorktreeSetupRequest(options));
			const key = await runWorktreeSteps(gitWorktreeSetupCacheKey(request));
			const existing = results.get(key);
			if (existing !== undefined) {
				const cached = await existing;
				await assertCachedGitWorktreeIdentity(cached, options);
				return cached.result;
			}
			assertOpen();
			const setup = setupCachedGitWorktree(request, ownerRunId);
			results.set(key, setup);
			setup.catch(() => {
				if (results.get(key) === setup) results.delete(key);
			});
			return (await setup).result;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const setups = await Promise.allSettled(results.values());
			results.clear();
			let firstError: Error | undefined;
			for (const setup of setups) {
				if (setup.status === "rejected") continue;
				try {
					await setup.value.identity.generation.dispose();
				} catch (error) {
					firstError ??= error instanceof Error ? error : new Error(String(error));
				}
			}
			if (firstError !== undefined) throw firstError;
		},
	};
}

async function setupCachedGitWorktree(
	request: GitWorktreeSetupRequest,
	ownerRunId: string | undefined,
): Promise<CachedGitWorktreeSetup> {
	const setup = await runWorktreeSteps(setupGitWorktreeFromRequest(request, ownerRunId));
	return { ...setup, identity: await captureGitWorktreeIdentity(setup) };
}

export async function setupGitWorktreeCached(
	options: GitWorktreeSetupOptions,
	cache?: GitWorktreeSetupCache,
): Promise<GitWorktreeSetupResult> {
	return cache === undefined
		? (await runWorktreeSteps(setupGitWorktreeSteps(options))).result
		: await cache.get(options);
}

function quoteShellArg(value: string): string {
	if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
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

function* shouldPreserveLogicalPath(logicalPath: string): WorktreeSteps<boolean> {
	for (const ancestor of pathAncestors(logicalPath)) {
		try {
			if ((yield* io("lstat", ancestor)).isSymbolicLink() && hasGrandparent(ancestor)) return true;
		} catch {}
	}
	return false;
}

function* canonicalizePreservingSymlinks(value: string): WorktreeSteps<string> {
	const logicalPath = path.resolve(value);
	const preserveLogicalPath = yield* shouldPreserveLogicalPath(logicalPath);
	try {
		const canonical = yield* io("realpath", logicalPath);
		return preserveLogicalPath && canonical !== logicalPath ? logicalPath : canonical;
	} catch {
		return logicalPath;
	}
}

function* resolveGitWorktreePath(value: string, baseDir: string): WorktreeSteps<string> {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("gitWorktreeDir cannot be empty");
	if (trimmed.includes("\0")) {
		throw new Error("gitWorktreeDir contains an unusable null byte; provide a valid path or omit gitWorktreeDir.");
	}
	return yield* canonicalizePreservingSymlinks(path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed));
}

function* comparableRealPath(value: string): WorktreeSteps<string> {
	const realpath = (yield* io("realpath", value)).replace(/\\/g, "/");
	return process.platform === "win32" ? realpath.toLowerCase() : realpath;
}

/** Split `value` into its nearest existing ancestor and the missing components below it. */
function* nearestExistingAncestor(
	value: string,
): WorktreeSteps<{ readonly existing: string; readonly missing: readonly string[] }> {
	let existing = path.resolve(value);
	const missing: string[] = [];
	while (!(yield* pathExists(existing))) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	return { existing, missing };
}

function* comparablePathThroughExistingAncestor(value: string): WorktreeSteps<string> {
	const { existing, missing } = yield* nearestExistingAncestor(value);
	const resolved = path.resolve(yield* comparableRealPath(existing), ...missing).replace(/\\/g, "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function* isFileOrLink(value: string): WorktreeSteps<boolean> {
	try {
		const entry = yield* io("lstat", value);
		return entry.isFile() || entry.isSymbolicLink();
	} catch {
		return false;
	}
}

function* isDirectory(value: string): WorktreeSteps<boolean> {
	try {
		return (yield* io("stat", value)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Whether `directory` is a Git directory by Git's own layout rule: a `.git`
 * directory, or a directory with `HEAD` plus either `commondir` (a linked
 * worktree's admin directory) or `objects` and `refs` (a main, bare or separate
 * Git directory).
 */
function* looksLikeGitDirectory(directory: string): WorktreeSteps<boolean> {
	if (!(yield* isDirectory(directory))) return false;
	if (path.basename(directory) === ".git") return true;
	if (!(yield* isFileOrLink(path.join(directory, "HEAD")))) return false;
	if (yield* isFileOrLink(path.join(directory, "commondir"))) return true;
	return (yield* isDirectory(path.join(directory, "objects"))) && (yield* isDirectory(path.join(directory, "refs")));
}

/** The Git directory that contains `target` (or would contain it once created), if any. */
function* enclosingGitMetadataDirectory(target: string): WorktreeSteps<string | undefined> {
	const { existing } = yield* nearestExistingAncestor(target);
	let realExisting = existing;
	try {
		realExisting = yield* io("realpath", existing);
	} catch {
		// Keep the logical spelling when the ancestor cannot be resolved.
	}
	for (const candidate of new Set([...pathAncestors(existing), ...pathAncestors(realExisting)])) {
		if (yield* looksLikeGitDirectory(candidate)) return candidate;
	}
	const insideGitDir = yield* gitReadOnlyProbeSteps(existing, ["rev-parse", "--is-inside-git-dir"]);
	if (insideGitDir.status !== 0 && isGitTimeoutResult(insideGitDir)) {
		throw new Error(
			`Timed out while validating gitWorktreeDir ${target}. Git reported: ${gitFailureMessage(insideGitDir)}`,
		);
	}
	return insideGitDir.status === 0 && insideGitDir.stdout.trim() === "true" ? existing : undefined;
}

/**
 * The one safety guard every gitWorktreeDir passes before anything is reused or
 * created. The path, or the nearest existing ancestor of a missing path, must not
 * be inside Git metadata (a `.git` directory, a linked worktree's admin directory,
 * a bare repository, or any other Git directory) nor inside the invoking checkout.
 * Inside any other Git working tree only that tree's own root is accepted, for
 * reuse; empty, missing and container paths below a working tree are rejected so
 * no checkout is nested inside another repository.
 */
function* assertSafeGitWorktreeTarget(target: string, invokingRoot: string | undefined): WorktreeSteps<void> {
	const gitDirectory = yield* enclosingGitMetadataDirectory(target);
	if (gitDirectory !== undefined) {
		throw new Error(
			`gitWorktreeDir must not be inside Git metadata: ${target} is inside the Git directory ${gitDirectory}. Choose a worktree root or a plain directory outside Git metadata.`,
		);
	}
	if (invokingRoot !== undefined) yield* validateWorktreeOutsideInvokingCheckout(target, invokingRoot);
	const { existing, missing } = yield* nearestExistingAncestor(target);
	const workingTree = yield* gitTopLevel(existing);
	if (workingTree === undefined) return;
	if (missing.length === 0 && (yield* comparableRealPath(target)) === (yield* comparableRealPath(workingTree))) return;
	throw new Error(
		`gitWorktreeDir must not be inside another Git working tree: ${target} is inside ${workingTree}. Pass that checkout's root to reuse it, or a path outside every Git checkout.`,
	);
}

function* validateWorktreeOutsideInvokingCheckout(worktreeRoot: string, repoRoot: string): WorktreeSteps<void> {
	const repository = yield* comparableRealPath(repoRoot);
	const candidate = yield* comparablePathThroughExistingAncestor(worktreeRoot);
	const relativePath = path.relative(repository, candidate);
	if (relativePath === "") {
		throw new Error(
			"gitWorktreeDir must not resolve to the invoking checkout; provide a separate worktree path outside it.",
		);
	}
	if (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath)) {
		throw new Error(
			"gitWorktreeDir must be outside the invoking checkout; provide a separate worktree path outside it.",
		);
	}
}

function gitPathFromOutput(value: string, cwd: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

function* pathExists(value: string): WorktreeSteps<boolean> {
	return (yield* pathStat(value)) !== undefined;
}

function* pathStat(value: string): WorktreeSteps<Stats | undefined> {
	try {
		return yield* io("stat", value);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

/**
 * Identify the checkout that contains the invoking cwd. A cwd outside any Git
 * checkout is not an error here: existing worktrees can still be reused from it.
 */
function* probeInvokingRepository(
	cwd: string,
): WorktreeSteps<{ readonly repository: InvokingRepository } | { readonly failure: string }> {
	const result = yield* gitReadOnlyProbeSteps(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) {
		if (isGitTimeoutResult(result)) {
			throw new Error(
				`Timed out while checking the Git repository for gitWorktreeDir from ${cwd}. Git reported: ${gitFailureMessage(result)}`,
			);
		}
		return { failure: gitFailureMessage(result) };
	}
	const root = gitPathFromOutput(result.stdout, cwd);
	if (root === undefined) {
		throw new Error(
			`gitWorktreeDir could not resolve the repository top level from ${cwd}: git returned an empty path.`,
		);
	}
	return { repository: { root, ...(yield* cwdWithinGitRepository(cwd, root)) } };
}

function* resolveGitWorktreeSetupRequest(options: GitWorktreeSetupOptions): WorktreeSteps<GitWorktreeSetupRequest> {
	const probe = yield* probeInvokingRepository(options.cwd);
	if ("repository" in probe) {
		return {
			options,
			repository: probe.repository,
			target: yield* resolveGitWorktreePath(options.gitWorktreeDir, probe.repository.logicalRoot),
		};
	}
	return {
		options,
		repositoryProbeFailure: probe.failure,
		target: yield* resolveGitWorktreePath(options.gitWorktreeDir, yield* canonicalizePreservingSymlinks(options.cwd)),
	};
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

function* gitTopLevel(cwd: string): WorktreeSteps<string | undefined> {
	return gitTopLevelFromResult(
		yield* gitReadOnlyProbeSteps(cwd, ["rev-parse", "--show-toplevel"]),
		cwd,
		`gitWorktreeDir ${cwd}`,
	);
}

function* gitCommonDirForWorktree(cwd: string): WorktreeSteps<string> {
	const result = yield* gitReadOnlyProbeSteps(cwd, ["rev-parse", "--git-common-dir"]);
	if (result.status !== 0) {
		if (isGitTimeoutResult(result)) {
			throw new Error(
				`Timed out while validating Git common directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`,
			);
		}
		throw new Error(
			`Failed to validate Git common directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`,
		);
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

function* cwdWithinGitRepository(
	cwd: string,
	repoRoot: string,
): WorktreeSteps<{ relativeCwd: string; logicalRoot: string }> {
	const sourceCwd = yield* io("realpath", cwd);
	const sourceRepoRoot = yield* io("realpath", repoRoot);
	const relativeCwd = path.relative(sourceRepoRoot, sourceCwd);
	const safeRelativeCwd = isPathInside(sourceRepoRoot, sourceCwd) ? relativeCwd : "";
	const logicalCwd = yield* canonicalizePreservingSymlinks(cwd);
	return {
		relativeCwd: safeRelativeCwd,
		logicalRoot: dirnameForEachRelativeComponent(logicalCwd, safeRelativeCwd) ?? repoRoot,
	};
}

function workspaceCwdForGitWorktreeRoot(worktreeRoot: string, relativeCwd: string): string {
	return relativeCwd === "" ? worktreeRoot : path.join(worktreeRoot, relativeCwd);
}

/**
 * Validate that `worktreeRoot` is the top level of a Git checkout and return the
 * checkout's own Git common directory, which identifies its repository.
 */
function* validateGitWorktreeRoot(worktreeRoot: string): WorktreeSteps<string> {
	const topLevel = yield* gitTopLevel(worktreeRoot);
	if (topLevel === undefined) {
		throw new Error(`gitWorktreeDir already exists but is not a Git worktree: ${worktreeRoot}`);
	}
	if ((yield* comparableRealPath(worktreeRoot)) !== (yield* comparableRealPath(topLevel))) {
		throw new Error(
			`gitWorktreeDir already exists but is not a Git worktree root: ${worktreeRoot}. Git top-level checkout is ${topLevel}`,
		);
	}
	return yield* gitCommonDirForWorktree(topLevel);
}

/**
 * Classify an existing non-empty directory that already passed
 * `assertSafeGitWorktreeTarget`. Returns the checkout's Git common directory when
 * it is a worktree root, or `undefined` when it is outside every Git checkout.
 * Subdirectories of a checkout are rejected so no workflow writes into them.
 */
function* existingGitWorktreeCommonDir(directory: string): WorktreeSteps<string | undefined> {
	return (yield* gitTopLevel(directory)) === undefined ? undefined : yield* validateGitWorktreeRoot(directory);
}

function* sameGitCommonDir(left: string, right: string): WorktreeSteps<boolean> {
	return (yield* comparableRealPath(left)) === (yield* comparableRealPath(right));
}

function* validateCreatedGitWorktree(worktreeRoot: string, repository: InvokingRepository): WorktreeSteps<void> {
	yield* assertSafeGitWorktreeTarget(worktreeRoot, repository.root);
	if (
		!(yield* sameGitCommonDir(
			yield* validateGitWorktreeRoot(worktreeRoot),
			yield* gitCommonDirForWorktree(repository.root),
		))
	) {
		throw new Error(`gitWorktreeDir does not belong to the invoking Git repository: ${worktreeRoot}`);
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

function* gitDirectoryForWorktree(cwd: string): WorktreeSteps<string> {
	const result = yield* gitReadOnlyProbeSteps(cwd, ["rev-parse", "--absolute-git-dir"]);
	if (result.status !== 0) {
		throw new Error(
			`Failed to validate Git directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`,
		);
	}
	const gitDir = gitPathFromOutput(result.stdout, cwd);
	if (gitDir === undefined) throw new Error("git rev-parse --absolute-git-dir returned an empty path");
	return gitDir;
}

function* captureGitWorktreeIdentitySnapshot(
	setup: ResolvedGitWorktreeSetup,
): WorktreeSteps<GitWorktreeIdentitySnapshot> {
	const { worktreeRoot, repositoryRoot } = setup.result;
	yield* assertSafeGitWorktreeTarget(worktreeRoot, setup.invokingRoot);
	const commonDir = yield* validateGitWorktreeRoot(worktreeRoot);
	const stats = yield* io("stat", worktreeRoot);
	return {
		worktreeRealPath: yield* comparableRealPath(worktreeRoot),
		repositoryRealPath: yield* comparableRealPath(repositoryRoot),
		gitDirRealPath: yield* comparableRealPath(yield* gitDirectoryForWorktree(worktreeRoot)),
		commonDirRealPath: yield* comparableRealPath(commonDir),
		device: stats.dev,
		inode: stats.ino,
	};
}

async function captureGitWorktreeIdentity(setup: ResolvedGitWorktreeSetup): Promise<GitWorktreeIdentity> {
	const snapshot = await runWorktreeSteps(captureGitWorktreeIdentitySnapshot(setup));
	return { ...snapshot, generation: await openGitWorktreeGenerationAnchor(setup.result.worktreeRoot) };
}

async function assertCachedGitWorktreeIdentity(
	cached: CachedGitWorktreeSetup,
	options: GitWorktreeSetupOptions,
): Promise<void> {
	let current: GitWorktreeIdentitySnapshot;
	try {
		current = await runWorktreeSteps(captureGitWorktreeIdentitySnapshot(cached));
		await cached.identity.generation.assertCurrent();
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
		throw new Error(
			`Cached gitWorktreeDir changed before reuse: ${options.gitWorktreeDir}. Start a new run with the intended worktree.`,
		);
	}
}

function requireInvokingRepository(request: GitWorktreeSetupRequest, action: string): InvokingRepository {
	if (request.repository !== undefined) return request.repository;
	throw new Error(
		[
			`gitWorktreeDir requires the workflow to be invoked from inside a Git repository to ${action}.`,
			"Start the workflow from a checkout of the repository the new worktree should come from, or set gitWorktreeDir to the root of an existing Git worktree to reuse it from any directory.",
			`Git reported: ${request.repositoryProbeFailure ?? "no repository"}`,
		].join(" "),
	);
}

function* setupGitWorktreeFromRequest(
	request: GitWorktreeSetupRequest,
	ownerRunId?: string,
): WorktreeSteps<ResolvedGitWorktreeSetup> {
	const { repository, target } = request;
	yield* assertSafeGitWorktreeTarget(target, repository?.root);
	const entry = yield* pathStat(target);
	if (entry === undefined) return yield* createGitWorktreeAtPath(request, false);
	if (!entry.isDirectory()) throw new Error(`gitWorktreeDir already exists but is not a directory: ${target}`);
	if ((yield* io("readdir", target)).length === 0) return yield* createGitWorktreeAtPath(request, true);

	const commonDir = yield* existingGitWorktreeCommonDir(target);
	if (commonDir === undefined) return yield* allocateGitWorktree(request, ownerRunId);
	// An existing worktree carries its own repository identity. The invoking cwd
	// only contributes its relative subdirectory when it is the same repository.
	const sameRepository =
		repository !== undefined && (yield* sameGitCommonDir(commonDir, yield* gitCommonDirForWorktree(repository.root)));
	return {
		result: {
			worktreeRoot: target,
			cwd: sameRepository ? workspaceCwdForGitWorktreeRoot(target, repository.relativeCwd) : target,
			repositoryRoot: sameRepository ? repository.root : target,
			created: false,
		},
		...(repository !== undefined ? { invokingRoot: repository.root } : {}),
	};
}

function* createGitWorktreeAtPath(
	request: GitWorktreeSetupRequest,
	existingEmptyDirectory: boolean,
): WorktreeSteps<ResolvedGitWorktreeSetup> {
	const { target: worktreeRoot } = request;
	const repository = requireInvokingRepository(request, `create a new worktree at ${worktreeRoot}`);
	const mainRoot = yield* findCanonicalGitRootSteps(repository.root);
	if (mainRoot === undefined) {
		throw new Error(`Unable to resolve the canonical main Git repository root from ${repository.root}.`);
	}
	if (!existingEmptyDirectory) {
		try {
			yield* io("mkdir", path.dirname(worktreeRoot), true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to create parent directory for requested gitWorktreeDir ${worktreeRoot}: ${message}`);
		}
	}
	const baseRef = request.options.baseBranch?.trim() || "HEAD";
	const result = yield* gitSteps(mainRoot, ["worktree", "add", "--detach", worktreeRoot, baseRef]);
	if (result.status !== 0) {
		throw new Error(
			[
				`Failed to create git worktree at requested gitWorktreeDir ${worktreeRoot} from ${baseRef}. Git reported: ${gitFailureMessage(result)}`,
				`If another process just created this same-repository worktree, rerun the workflow to resume it. If this is an orphaned worktree from an interrupted run, recover or remove it with: ${worktreeRecoveryCommand(mainRoot, worktreeRoot)}`,
			].join("\n"),
		);
	}
	try {
		yield* validateCreatedGitWorktree(worktreeRoot, repository);
	} catch (error) {
		// Best-effort rollback of a target that changed while Git was creating it.
		yield* gitSteps(mainRoot, ["worktree", "remove", "--force", worktreeRoot]);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Created gitWorktreeDir failed post-creation validation: ${message}`);
	}
	return {
		result: {
			worktreeRoot,
			cwd: workspaceCwdForGitWorktreeRoot(worktreeRoot, repository.relativeCwd),
			repositoryRoot: repository.root,
			created: true,
		},
		invokingRoot: repository.root,
	};
}

/** Workspace cwd inside `checkout`, rejected when it is missing or resolves outside the checkout. */
function* containedWorktreeCwd(checkout: string, relativeCwd: string): WorktreeSteps<string> {
	const cwd = workspaceCwdForGitWorktreeRoot(checkout, relativeCwd);
	let resolved: string;
	try {
		resolved = yield* io("realpath", cwd);
	} catch {
		resolved = "";
	}
	const relative = resolved === "" ? undefined : path.relative(yield* io("realpath", checkout), resolved);
	if (
		relative === undefined ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		!(yield* io("stat", resolved)).isDirectory()
	) {
		throw new Error(
			`The selected base does not contain a working directory ${relativeCwd || "."} inside the worktree ${checkout}.`,
		);
	}
	return cwd;
}

function* allocatedGitWorktreeSetup(
	checkout: string,
	repository: InvokingRepository,
	created: boolean,
): WorktreeSteps<ResolvedGitWorktreeSetup> {
	return {
		result: {
			worktreeRoot: checkout,
			cwd: yield* containedWorktreeCwd(checkout, repository.relativeCwd),
			repositoryRoot: repository.root,
			created,
		},
		invokingRoot: repository.root,
	};
}

/** Validate a checkout this run allocated earlier: a linked worktree of the invoking repository whose Git directory points back to it. */
function* validateOwnedGitWorktree(checkout: string, repository: InvokingRepository): WorktreeSteps<void> {
	yield* validateCreatedGitWorktree(checkout, repository);
	const gitDir = yield* gitDirectoryForWorktree(checkout);
	if (yield* sameGitCommonDir(gitDir, yield* gitCommonDirForWorktree(checkout))) {
		throw new Error(`${checkout} is not a linked worktree`);
	}
	const backlink = (yield* io("readFile", path.join(gitDir, "gitdir"))).trim();
	if (
		!backlink ||
		(yield* comparableRealPath(path.resolve(gitDir, backlink))) !==
			(yield* comparableRealPath(path.join(checkout, ".git")))
	) {
		throw new Error(`the Git directory of ${checkout} belongs to another checkout`);
	}
}

function* findOwnedGitWorktree(
	root: string,
	repository: InvokingRepository,
	ownerRunId: string,
): WorktreeSteps<ResolvedGitWorktreeSetup | undefined> {
	const [checkout] = yield* findOwnedWorktreeCheckouts(root, path.basename(repository.root), ownerRunId);
	if (checkout === undefined) return undefined;
	try {
		yield* validateOwnedGitWorktree(checkout, repository);
		return yield* allocatedGitWorktreeSetup(checkout, repository, false);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`The worktree this workflow run allocated under gitWorktreeDir ${root} can no longer be reused: ${checkout}. ${message}`,
		);
	}
}

/**
 * Treat an existing non-empty, non-Git directory as a worktree root: allocate a
 * fresh `<root>/<4-hex bucket>/<repository-name>` checkout from the invoking
 * repository, populate it, and record which run owns it. Any failure rolls the
 * checkout and its bucket back.
 */
function* allocateGitWorktree(
	request: GitWorktreeSetupRequest,
	ownerRunId?: string,
): WorktreeSteps<ResolvedGitWorktreeSetup> {
	const { target: root } = request;
	const repository = requireInvokingRepository(request, `create a new worktree under ${root}`);
	if (ownerRunId !== undefined) {
		const owned = yield* findOwnedGitWorktree(root, repository, ownerRunId);
		if (owned !== undefined) return owned;
	}
	const baseRef = request.options.baseBranch?.trim() || "HEAD";
	const revision = yield* gitSteps(repository.root, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${baseRef}^{commit}`,
	]);
	const commit = revision.status === 0 ? revision.stdout.trim() : "";
	if (commit === "") {
		throw new Error(
			`Failed to resolve ${baseRef} to a commit for gitWorktreeDir ${root}. Git reported: ${gitFailureMessage(revision)}`,
		);
	}

	const checkout = yield* allocateWorktreeCheckoutPath(root, path.basename(repository.root));
	const add = yield* gitSteps(repository.root, ["worktree", "add", "--detach", "--no-checkout", checkout, commit]);
	if (add.status !== 0) {
		yield* removeEmptyWorktreeBucket(checkout);
		throw new Error(
			`Failed to create git worktree at ${checkout} under gitWorktreeDir ${root} from ${baseRef}. Git reported: ${gitFailureMessage(add)}`,
		);
	}
	try {
		const gitDir = yield* gitDirectoryForWorktree(checkout);
		// Pin this checkout's own config only, then materialize files from the commit.
		yield* runGitOrThrow(checkout, [
			"config",
			"--file",
			path.join(gitDir, "config.worktree"),
			"core.worktree",
			checkout,
		]);
		yield* runGitOrThrow(checkout, ["--work-tree=.", "reset", "--hard", "--no-recurse-submodules", commit]);
		yield* validateCreatedGitWorktree(checkout, repository);
		const setup = yield* allocatedGitWorktreeSetup(checkout, repository, true);
		if (ownerRunId !== undefined) yield* bindWorktreeOwner(gitDir, ownerRunId);
		return setup;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const removal = yield* gitSteps(repository.root, ["worktree", "remove", "--force", checkout]);
		yield* removeEmptyWorktreeBucket(checkout);
		const rollback =
			removal.status === 0
				? ""
				: ` Rolling back the incomplete worktree also failed; remove it with: ${worktreeRecoveryCommand(repository.root, checkout)}`;
		throw new Error(
			`Failed to set up git worktree at ${checkout} under gitWorktreeDir ${root}: ${message}${rollback}`,
		);
	}
}

function* runGitOrThrow(cwd: string, args: readonly string[]): WorktreeSteps<void> {
	const result = yield* gitSteps(cwd, args);
	if (result.status !== 0) throw new Error(gitFailureMessage(result));
}

function* setupGitWorktreeSteps(options: GitWorktreeSetupOptions): WorktreeSteps<ResolvedGitWorktreeSetup> {
	return yield* setupGitWorktreeFromRequest(yield* resolveGitWorktreeSetupRequest(options));
}

export function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult {
	return runWorktreeStepsSync(setupGitWorktreeSteps(options)).result;
}
