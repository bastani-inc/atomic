import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGitEnvironment } from "@bastani/atomic";
import type { GitResult, GitWorktreeSetupOptions, GitWorktreeSetupResult } from "./worktree-types.js";

const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_COMMAND_TIMEOUT_MS = 60_000;


export function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", [
		"-c",
		`core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`,
		"-c",
		"core.fsmonitor=false",
		...args,
	], {
		cwd,
		encoding: "utf-8",
		env: createGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }),
		timeout: GIT_COMMAND_TIMEOUT_MS,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		...(result.error === undefined ? {} : { error: result.error }),
	};
}

export function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function gitErrorCode(error: Error): string | undefined {
	return "code" in error ? String((error as Error & { readonly code?: unknown }).code) : undefined;
}

export function isGitTimeoutResult(result: GitResult): boolean {
	const error = result.error;
	if (error === undefined) return false;
	const code = gitErrorCode(error)?.toUpperCase();
	const message = error.message.toLowerCase();
	return code === "ETIMEDOUT" || message.includes("etimedout") || message.includes("timed out");
}

export function gitFailureMessage(result: GitResult): string {
	if (result.error !== undefined) {
		const code = gitErrorCode(result.error);
		if (isGitTimeoutResult(result)) {
			return `git command timed out after ${GIT_COMMAND_TIMEOUT_MS}ms${code === undefined ? "" : ` (${code})`}: ${result.error.message}`;
		}
		return code === undefined ? result.error.message : `${code}: ${result.error.message}`;
	}
	return result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.status}`;
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
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
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
	return gitTopLevelFromResult(runGit(cwd, ["rev-parse", "--show-toplevel"]), cwd, `gitWorktreeDir ${cwd}`);
}

function gitCommonDirForWorktree(cwd: string): string {
	const result = runGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (result.status !== 0) throw new Error(gitFailureMessage(result));
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

export function setupGitWorktree(options: GitWorktreeSetupOptions): GitWorktreeSetupResult {
	const repoRoot = repositoryRootForGitWorktree(options.cwd);
	const { relativeCwd, logicalRepoRoot } = cwdWithinGitRepository(options.cwd, repoRoot);
	const worktreeRoot = resolveGitWorktreePath(options.gitWorktreeDir, logicalRepoRoot);
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
	const result = runGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseRef]);
	if (result.status !== 0) {
		throw new Error([
			`Failed to create git worktree at requested gitWorktreeDir ${worktreeRoot} from ${baseRef}. Git reported: ${gitFailureMessage(result)}`,
			`If another process just created this same-repository worktree, rerun the workflow to resume it. If this is an orphaned worktree from an interrupted run, recover or remove it with: ${worktreeRecoveryCommand(repoRoot, worktreeRoot)}`,
		].join("\n"));
	}
	return {
		worktreeRoot,
		cwd: workspaceCwdForGitWorktreeRoot(worktreeRoot, relativeCwd),
		repositoryRoot: repoRoot,
		created: true,
	};
}
