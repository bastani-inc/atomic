import * as fs from "node:fs";
import * as path from "node:path";
import {
	allocateWorktreeCheckoutPath,
	bindWorktreeOwner,
	findOwnedWorktreeCheckouts,
	removeEmptyWorktreeBucket,
} from "./worktree-allocation.js";
import { type GitWorktreeGenerationAnchor, openGitWorktreeGenerationAnchor } from "./worktree-generation.js";
import { gitFailureMessage, isGitTimeoutResult, runGit, runGitReadOnlyProbe } from "./worktree-git-runner.js";
import { findCanonicalGitRoot } from "./worktree-root.js";
import type { GitResult, GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./worktree-types.js";

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
	get(options: GitWorktreeSetupOptions): GitWorktreeSetupResult;
	dispose(): void;
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

function gitWorktreeSetupCacheKey(request: GitWorktreeSetupRequest): string {
	return JSON.stringify([
		comparablePathThroughExistingAncestor(request.options.cwd),
		comparablePathThroughExistingAncestor(request.target),
	]);
}

/**
 * Create a setup cache for one workflow run. `ownerRunId` identifies the run that
 * owns checkouts allocated under a non-empty gitWorktreeDir, so resuming the same
 * run finds its checkout again instead of allocating another one.
 */
export function createGitWorktreeSetupCache(ownerRunId?: string): GitWorktreeSetupCache {
	const results = new Map<string, CachedGitWorktreeSetup>();
	let disposed = false;
	return {
		get(options) {
			if (disposed) throw new Error("Git worktree setup cache is already disposed");
			const request = resolveGitWorktreeSetupRequest(options);
			const key = gitWorktreeSetupCacheKey(request);
			const cached = results.get(key);
			if (cached !== undefined) {
				assertCachedGitWorktreeIdentity(cached, options);
				return cached.result;
			}
			const setup = setupGitWorktreeFromRequest(request, ownerRunId);
			results.set(key, { ...setup, identity: captureGitWorktreeIdentity(setup) });
			return setup.result;
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

export function setupGitWorktreeCached(
	options: GitWorktreeSetupOptions,
	cache?: GitWorktreeSetupCache,
): GitWorktreeSetupResult {
	return cache?.get(options) ?? setupGitWorktree(options);
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

function resolveGitWorktreePath(value: string, baseDir: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("gitWorktreeDir cannot be empty");
	if (trimmed.includes("\0")) {
		throw new Error("gitWorktreeDir contains an unusable null byte; provide a valid path or omit gitWorktreeDir.");
	}
	return canonicalizePreservingSymlinks(path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed));
}

function comparableRealPath(value: string): string {
	const realpath = fs.realpathSync.native(value).replace(/\\/g, "/");
	return process.platform === "win32" ? realpath.toLowerCase() : realpath;
}

/** Split `value` into its nearest existing ancestor and the missing components below it. */
function nearestExistingAncestor(value: string): { readonly existing: string; readonly missing: readonly string[] } {
	let existing = path.resolve(value);
	const missing: string[] = [];
	while (!pathExistsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	return { existing, missing };
}

function comparablePathThroughExistingAncestor(value: string): string {
	const { existing, missing } = nearestExistingAncestor(value);
	const resolved = path.resolve(comparableRealPath(existing), ...missing).replace(/\\/g, "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFileOrLink(value: string): boolean {
	try {
		const entry = fs.lstatSync(value);
		return entry.isFile() || entry.isSymbolicLink();
	} catch {
		return false;
	}
}

function isDirectory(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
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
function looksLikeGitDirectory(directory: string): boolean {
	if (!isDirectory(directory)) return false;
	if (path.basename(directory) === ".git") return true;
	if (!isFileOrLink(path.join(directory, "HEAD"))) return false;
	if (isFileOrLink(path.join(directory, "commondir"))) return true;
	return isDirectory(path.join(directory, "objects")) && isDirectory(path.join(directory, "refs"));
}

/** The Git directory that contains `target` (or would contain it once created), if any. */
function enclosingGitMetadataDirectory(target: string): string | undefined {
	const { existing } = nearestExistingAncestor(target);
	let realExisting = existing;
	try {
		realExisting = fs.realpathSync.native(existing);
	} catch {
		// Keep the logical spelling when the ancestor cannot be resolved.
	}
	for (const candidate of new Set([...pathAncestors(existing), ...pathAncestors(realExisting)])) {
		if (looksLikeGitDirectory(candidate)) return candidate;
	}
	const insideGitDir = runGitReadOnlyProbe(existing, ["rev-parse", "--is-inside-git-dir"]);
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
function assertSafeGitWorktreeTarget(target: string, invokingRoot: string | undefined): void {
	const gitDirectory = enclosingGitMetadataDirectory(target);
	if (gitDirectory !== undefined) {
		throw new Error(
			`gitWorktreeDir must not be inside Git metadata: ${target} is inside the Git directory ${gitDirectory}. Choose a worktree root or a plain directory outside Git metadata.`,
		);
	}
	if (invokingRoot !== undefined) validateWorktreeOutsideInvokingCheckout(target, invokingRoot);
	const { existing, missing } = nearestExistingAncestor(target);
	const workingTree = gitTopLevel(existing);
	if (workingTree === undefined) return;
	if (missing.length === 0 && comparableRealPath(target) === comparableRealPath(workingTree)) return;
	throw new Error(
		`gitWorktreeDir must not be inside another Git working tree: ${target} is inside ${workingTree}. Pass that checkout's root to reuse it, or a path outside every Git checkout.`,
	);
}

function validateWorktreeOutsideInvokingCheckout(worktreeRoot: string, repoRoot: string): void {
	const repository = comparableRealPath(repoRoot);
	const candidate = comparablePathThroughExistingAncestor(worktreeRoot);
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

function pathExistsSync(value: string): boolean {
	return pathStatSync(value) !== undefined;
}

function pathStatSync(value: string): fs.Stats | undefined {
	try {
		return fs.statSync(value);
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
function probeInvokingRepository(
	cwd: string,
): { readonly repository: InvokingRepository } | { readonly failure: string } {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--show-toplevel"]);
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
	return { repository: { root, ...cwdWithinGitRepository(cwd, root) } };
}

function resolveGitWorktreeSetupRequest(options: GitWorktreeSetupOptions): GitWorktreeSetupRequest {
	const probe = probeInvokingRepository(options.cwd);
	if ("repository" in probe) {
		return {
			options,
			repository: probe.repository,
			target: resolveGitWorktreePath(options.gitWorktreeDir, probe.repository.logicalRoot),
		};
	}
	return {
		options,
		repositoryProbeFailure: probe.failure,
		target: resolveGitWorktreePath(options.gitWorktreeDir, canonicalizePreservingSymlinks(options.cwd)),
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

function gitTopLevel(cwd: string): string | undefined {
	return gitTopLevelFromResult(
		runGitReadOnlyProbe(cwd, ["rev-parse", "--show-toplevel"]),
		cwd,
		`gitWorktreeDir ${cwd}`,
	);
}

function gitCommonDirForWorktree(cwd: string): string {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--git-common-dir"]);
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

function cwdWithinGitRepository(cwd: string, repoRoot: string): { relativeCwd: string; logicalRoot: string } {
	const sourceCwd = fs.realpathSync.native(cwd);
	const sourceRepoRoot = fs.realpathSync.native(repoRoot);
	const relativeCwd = path.relative(sourceRepoRoot, sourceCwd);
	const safeRelativeCwd =
		relativeCwd === "" || relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd) ? "" : relativeCwd;
	const logicalCwd = canonicalizePreservingSymlinks(cwd);
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
function validateGitWorktreeRoot(worktreeRoot: string): string {
	const topLevel = gitTopLevel(worktreeRoot);
	if (topLevel === undefined) {
		throw new Error(`gitWorktreeDir already exists but is not a Git worktree: ${worktreeRoot}`);
	}
	if (comparableRealPath(worktreeRoot) !== comparableRealPath(topLevel)) {
		throw new Error(
			`gitWorktreeDir already exists but is not a Git worktree root: ${worktreeRoot}. Git top-level checkout is ${topLevel}`,
		);
	}
	return gitCommonDirForWorktree(topLevel);
}

/**
 * Classify an existing non-empty directory that already passed
 * `assertSafeGitWorktreeTarget`. Returns the checkout's Git common directory when
 * it is a worktree root, or `undefined` when it is outside every Git checkout.
 * Subdirectories of a checkout are rejected so no workflow writes into them.
 */
function existingGitWorktreeCommonDir(directory: string): string | undefined {
	return gitTopLevel(directory) === undefined ? undefined : validateGitWorktreeRoot(directory);
}

function sameGitCommonDir(left: string, right: string): boolean {
	return comparableRealPath(left) === comparableRealPath(right);
}

function validateCreatedGitWorktree(worktreeRoot: string, repository: InvokingRepository): void {
	assertSafeGitWorktreeTarget(worktreeRoot, repository.root);
	if (!sameGitCommonDir(validateGitWorktreeRoot(worktreeRoot), gitCommonDirForWorktree(repository.root))) {
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

function gitDirectoryForWorktree(cwd: string): string {
	const result = runGitReadOnlyProbe(cwd, ["rev-parse", "--absolute-git-dir"]);
	if (result.status !== 0) {
		throw new Error(
			`Failed to validate Git directory for gitWorktreeDir ${cwd}. Git reported: ${gitFailureMessage(result)}`,
		);
	}
	const gitDir = gitPathFromOutput(result.stdout, cwd);
	if (gitDir === undefined) throw new Error("git rev-parse --absolute-git-dir returned an empty path");
	return gitDir;
}

function captureGitWorktreeIdentitySnapshot(setup: ResolvedGitWorktreeSetup): GitWorktreeIdentitySnapshot {
	const { worktreeRoot, repositoryRoot } = setup.result;
	assertSafeGitWorktreeTarget(worktreeRoot, setup.invokingRoot);
	const commonDir = validateGitWorktreeRoot(worktreeRoot);
	const stats = fs.statSync(worktreeRoot);
	return {
		worktreeRealPath: comparableRealPath(worktreeRoot),
		repositoryRealPath: comparableRealPath(repositoryRoot),
		gitDirRealPath: comparableRealPath(gitDirectoryForWorktree(worktreeRoot)),
		commonDirRealPath: comparableRealPath(commonDir),
		device: stats.dev,
		inode: stats.ino,
	};
}

function captureGitWorktreeIdentity(setup: ResolvedGitWorktreeSetup): GitWorktreeIdentity {
	const snapshot = captureGitWorktreeIdentitySnapshot(setup);
	return { ...snapshot, generation: openGitWorktreeGenerationAnchor(setup.result.worktreeRoot) };
}

function assertCachedGitWorktreeIdentity(cached: CachedGitWorktreeSetup, options: GitWorktreeSetupOptions): void {
	let current: GitWorktreeIdentitySnapshot;
	try {
		current = captureGitWorktreeIdentitySnapshot(cached);
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

function setupGitWorktreeFromRequest(request: GitWorktreeSetupRequest, ownerRunId?: string): ResolvedGitWorktreeSetup {
	const { repository, target } = request;
	assertSafeGitWorktreeTarget(target, repository?.root);
	const entry = pathStatSync(target);
	if (entry === undefined) return createGitWorktreeAtPath(request, false);
	if (!entry.isDirectory()) throw new Error(`gitWorktreeDir already exists but is not a directory: ${target}`);
	if (fs.readdirSync(target).length === 0) return createGitWorktreeAtPath(request, true);

	const commonDir = existingGitWorktreeCommonDir(target);
	if (commonDir === undefined) return allocateGitWorktree(request, ownerRunId);
	// An existing worktree carries its own repository identity. The invoking cwd
	// only contributes its relative subdirectory when it is the same repository.
	const sameRepository =
		repository !== undefined && sameGitCommonDir(commonDir, gitCommonDirForWorktree(repository.root));
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

function createGitWorktreeAtPath(
	request: GitWorktreeSetupRequest,
	existingEmptyDirectory: boolean,
): ResolvedGitWorktreeSetup {
	const { target: worktreeRoot } = request;
	const repository = requireInvokingRepository(request, `create a new worktree at ${worktreeRoot}`);
	const mainRoot = findCanonicalGitRoot(repository.root);
	if (mainRoot === undefined) {
		throw new Error(`Unable to resolve the canonical main Git repository root from ${repository.root}.`);
	}
	if (!existingEmptyDirectory) {
		try {
			fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to create parent directory for requested gitWorktreeDir ${worktreeRoot}: ${message}`);
		}
	}
	const baseRef = request.options.baseBranch?.trim() || "HEAD";
	const result = runGit(mainRoot, ["worktree", "add", "--detach", worktreeRoot, baseRef]);
	if (result.status !== 0) {
		throw new Error(
			[
				`Failed to create git worktree at requested gitWorktreeDir ${worktreeRoot} from ${baseRef}. Git reported: ${gitFailureMessage(result)}`,
				`If another process just created this same-repository worktree, rerun the workflow to resume it. If this is an orphaned worktree from an interrupted run, recover or remove it with: ${worktreeRecoveryCommand(mainRoot, worktreeRoot)}`,
			].join("\n"),
		);
	}
	try {
		validateCreatedGitWorktree(worktreeRoot, repository);
	} catch (error) {
		// Best-effort rollback of a target that changed while Git was creating it.
		runGit(mainRoot, ["worktree", "remove", "--force", worktreeRoot]);
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
function containedWorktreeCwd(checkout: string, relativeCwd: string): string {
	const cwd = workspaceCwdForGitWorktreeRoot(checkout, relativeCwd);
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(cwd);
	} catch {
		resolved = "";
	}
	const relative = resolved === "" ? undefined : path.relative(fs.realpathSync.native(checkout), resolved);
	if (
		relative === undefined ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		!fs.statSync(resolved).isDirectory()
	) {
		throw new Error(
			`The selected base does not contain a working directory ${relativeCwd || "."} inside the worktree ${checkout}.`,
		);
	}
	return cwd;
}

function allocatedGitWorktreeSetup(
	checkout: string,
	repository: InvokingRepository,
	created: boolean,
): ResolvedGitWorktreeSetup {
	return {
		result: {
			worktreeRoot: checkout,
			cwd: containedWorktreeCwd(checkout, repository.relativeCwd),
			repositoryRoot: repository.root,
			created,
		},
		invokingRoot: repository.root,
	};
}

/** Validate a checkout this run allocated earlier: a linked worktree of the invoking repository whose Git directory points back to it. */
function validateOwnedGitWorktree(checkout: string, repository: InvokingRepository): void {
	validateCreatedGitWorktree(checkout, repository);
	const gitDir = gitDirectoryForWorktree(checkout);
	if (sameGitCommonDir(gitDir, gitCommonDirForWorktree(checkout))) {
		throw new Error(`${checkout} is not a linked worktree`);
	}
	const backlink = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
	if (
		!backlink ||
		comparableRealPath(path.resolve(gitDir, backlink)) !== comparableRealPath(path.join(checkout, ".git"))
	) {
		throw new Error(`the Git directory of ${checkout} belongs to another checkout`);
	}
}

function findOwnedGitWorktree(
	root: string,
	repository: InvokingRepository,
	ownerRunId: string,
): ResolvedGitWorktreeSetup | undefined {
	const [checkout] = findOwnedWorktreeCheckouts(root, path.basename(repository.root), ownerRunId);
	if (checkout === undefined) return undefined;
	try {
		validateOwnedGitWorktree(checkout, repository);
		return allocatedGitWorktreeSetup(checkout, repository, false);
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
function allocateGitWorktree(request: GitWorktreeSetupRequest, ownerRunId?: string): ResolvedGitWorktreeSetup {
	const { target: root } = request;
	const repository = requireInvokingRepository(request, `create a new worktree under ${root}`);
	if (ownerRunId !== undefined) {
		const owned = findOwnedGitWorktree(root, repository, ownerRunId);
		if (owned !== undefined) return owned;
	}
	const baseRef = request.options.baseBranch?.trim() || "HEAD";
	const revision = runGit(repository.root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
	const commit = revision.status === 0 ? revision.stdout.trim() : "";
	if (commit === "") {
		throw new Error(
			`Failed to resolve ${baseRef} to a commit for gitWorktreeDir ${root}. Git reported: ${gitFailureMessage(revision)}`,
		);
	}

	const checkout = allocateWorktreeCheckoutPath(root, path.basename(repository.root));
	const add = runGit(repository.root, ["worktree", "add", "--detach", "--no-checkout", checkout, commit]);
	if (add.status !== 0) {
		removeEmptyWorktreeBucket(checkout);
		throw new Error(
			`Failed to create git worktree at ${checkout} under gitWorktreeDir ${root} from ${baseRef}. Git reported: ${gitFailureMessage(add)}`,
		);
	}
	try {
		const gitDir = gitDirectoryForWorktree(checkout);
		// Pin this checkout's own config only, then materialize files from the commit.
		runGitOrThrow(checkout, ["config", "--file", path.join(gitDir, "config.worktree"), "core.worktree", checkout]);
		runGitOrThrow(checkout, ["--work-tree=.", "reset", "--hard", "--no-recurse-submodules", commit]);
		validateCreatedGitWorktree(checkout, repository);
		const setup = allocatedGitWorktreeSetup(checkout, repository, true);
		if (ownerRunId !== undefined) bindWorktreeOwner(gitDir, ownerRunId);
		return setup;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const removal = runGit(repository.root, ["worktree", "remove", "--force", checkout]);
		removeEmptyWorktreeBucket(checkout);
		const rollback =
			removal.status === 0
				? ""
				: ` Rolling back the incomplete worktree also failed; remove it with: ${worktreeRecoveryCommand(repository.root, checkout)}`;
		throw new Error(
			`Failed to set up git worktree at ${checkout} under gitWorktreeDir ${root}: ${message}${rollback}`,
		);
	}
}

function runGitOrThrow(cwd: string, args: readonly string[]): void {
	const result = runGit(cwd, args);
	if (result.status !== 0) throw new Error(gitFailureMessage(result));
}

export function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult {
	return setupGitWorktreeFromRequest(resolveGitWorktreeSetupRequest(options)).result;
}
