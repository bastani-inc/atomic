import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitEnvironment } from "@bastani/atomic";
import { resolveTemporaryWorktreeBaseRef } from "./worktree-base-ref.js";
import { runGit, runGitChecked } from "./worktree-git.js";
import { buildWorktreeBranch, buildWorktreePath, ensureWorktreeDirectory } from "./worktree-paths.js";
import { performPostCreationSetup } from "./worktree-post-create.js";
import { resolveMainRepoRoot } from "./worktree-root.js";
import type {
	CreateWorktreesOptions,
	RepoState,
	ResolvedWorktreeSetupHook,
	WorktreeInfo,
	WorktreeSetup,
	WorktreeSetupHookConfig,
	WorktreeSetupHookInput,
	WorktreeSetupHookOutput,
	WorktreeTaskCwdConflict,
} from "./worktree-types.js";

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function checkoutRootFromGit(cwd: string): string {
	return runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

function resolveRepoState(cwd: string): RepoState {
	const checkoutRoot = checkoutRootFromGit(cwd);
	const mainRoot = resolveMainRepoRoot(checkoutRoot);
	if (mainRoot === undefined) throw new Error("worktree isolation requires valid Git worktree metadata");
	const relative = path.relative(fs.realpathSync.native(checkoutRoot), fs.realpathSync.native(cwd));
	const cwdRelative = relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? "" : relative;
	const status = runGitChecked(checkoutRoot, ["status", "--porcelain", "--untracked-files=no"]);
	if (status.trim().length > 0) throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	const baseCommit = runGitChecked(checkoutRoot, ["rev-parse", "HEAD"]).trim();
	return { checkoutRoot, mainRoot, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
	const checkoutRoot = checkoutRootFromGit(cwd);
	const mainRoot = resolveMainRepoRoot(checkoutRoot);
	if (mainRoot === undefined) throw new Error("worktree isolation requires valid Git worktree metadata");
	const relative = path.relative(fs.realpathSync.native(checkoutRoot), fs.realpathSync.native(cwd));
	const cwdRelative = relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? "" : relative;
	const worktreePath = buildWorktreePath(mainRoot, runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}


function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): string[] {
	const result = spawnSync(hook.hookPath, [], {
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
		env: createGitEnvironment(),
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function waitForGitLockRelease(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function removeWorktreeAndBranch(repoCwd: string, worktreePath: string, branch: string): void {
	try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktreePath]); } catch {
		// Idempotent best-effort cleanup.
	}
	waitForGitLockRelease();
	try { runGitChecked(repoCwd, ["branch", "-D", branch]); } catch {
		// Idempotent best-effort cleanup.
	}
}

function createSingleWorktree(
	repo: RepoState,
	runId: string,
	index: number,
	baseRef: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	options: CreateWorktreesOptions,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(repo.mainRoot, runId, index);
	const baseCommit = runGitChecked(repo.mainRoot, ["rev-parse", `${baseRef}^{commit}`]).trim();
	const add = runGit(repo.mainRoot, ["worktree", "add", "-B", branch, worktreePath, baseRef]);
	if (add.status !== 0) {
		waitForGitLockRelease();
		try { runGitChecked(repo.mainRoot, ["branch", "-D", branch]); } catch {}
		throw new Error(add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`);
	}
	const agentCwd = repo.cwdRelative ? path.join(worktreePath, repo.cwdRelative) : worktreePath;
	try {
		const syntheticPaths = performPostCreationSetup(repo.mainRoot, worktreePath, options.symlinkDirectories ?? [], runGit);
		if (setupHook) {
			syntheticPaths.push(...runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: repo.mainRoot,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent: options.agents?.[index],
			}));
		}
		return { path: worktreePath, agentCwd, branch, baseCommit, index, nodeModulesLinked: syntheticPaths.includes("node_modules"), syntheticPaths };
	} catch (error) {
		removeWorktreeAndBranch(repo.mainRoot, worktreePath, branch);
		throw error;
	}
}

export function createWorktrees(cwd: string, runId: string, count: number, options: CreateWorktreesOptions = {}): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	ensureWorktreeDirectory(repo.mainRoot);
	const setupHook = resolveWorktreeSetupHook(repo.mainRoot, options.setupHook);
	const worktrees: WorktreeInfo[] = [];
	try {
		for (let index = 0; index < count; index++) {
			const explicitBase = options.baseBranches?.[index] ?? options.baseBranch;
			const baseRef = resolveTemporaryWorktreeBaseRef(repo.mainRoot, repo.baseCommit, explicitBase, runGit);
			worktrees.push(createSingleWorktree(repo, runId, index, baseRef, setupHook, options));
		}
	} catch (error) {
		cleanupWorktrees({ cwd: repo.mainRoot, worktrees, baseCommit: repo.baseCommit });
		throw error;
	}
	return { cwd: repo.mainRoot, worktrees, baseCommit: repo.baseCommit };
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		const worktree = setup.worktrees[index]!;
		removeWorktreeAndBranch(setup.cwd, worktree.path, worktree.branch);
	}
}
