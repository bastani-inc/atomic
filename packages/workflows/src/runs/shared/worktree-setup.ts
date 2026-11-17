import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createChildProcessEnvironment } from "@bastani/atomic";
import { pathExists } from "../../shared/path-exists.js";
import { spawnCollect } from "./spawn-collect.js";
import { worktreeDiffCaptureFailed } from "./worktree-diff.js";
import { runGit, runGitChecked } from "./worktree-git.js";
import { performPostCreationSetup } from "./worktree-post-create.js";
import { findCanonicalGitRoot } from "./worktree-root.js";
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

const HOOK_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

async function originDefaultBranch(mainRoot: string): Promise<string | undefined> {
	const symbolic = await runGit(mainRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	let branch =
		symbolic.status === 0 && symbolic.stdout.trim().startsWith("origin/")
			? symbolic.stdout.trim().slice("origin/".length)
			: undefined;
	if (!branch) {
		const remote = await runGit(mainRoot, ["remote", "show", "origin"]);
		branch = remote.status === 0 ? remote.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m)?.[1] : undefined;
	}
	if (!branch || branch === "(unknown)") return undefined;
	const remoteRef = `refs/remotes/origin/${branch}`;
	if ((await runGit(mainRoot, ["show-ref", "--verify", "--quiet", remoteRef])).status !== 0) {
		if ((await runGit(mainRoot, ["fetch", "origin", `${branch}:${remoteRef}`])).status !== 0) return undefined;
	}
	return `origin/${branch}`;
}

async function resolveRepoState(cwd: string, explicitBaseBranch?: string): Promise<RepoState> {
	const cwdRelative = await resolveRepoCwdRelative(cwd);
	const toplevel = path.resolve((await runGitChecked(cwd, ["rev-parse", "--show-toplevel"])).trim());
	const mainRoot = await findCanonicalGitRoot(toplevel);
	if (mainRoot === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);

	const status = await runGitChecked(toplevel, ["status", "--porcelain", "--untracked-files=no"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseRef = explicitBaseBranch?.trim() || (await originDefaultBranch(mainRoot)) || "HEAD";
	const baseCommit = (await runGitChecked(mainRoot, ["rev-parse", baseRef])).trim();
	return { toplevel, mainRoot, cwdRelative, baseCommit, baseRef };
}

async function normalizeComparableCwd(cwd: string): Promise<string> {
	const resolved = path.resolve(cwd);
	try {
		return await realpath(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export async function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): Promise<WorktreeTaskCwdConflict | undefined> {
	const normalizedSharedCwd = await normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if ((await normalizeComparableCwd(taskCwd)) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(conflict: WorktreeTaskCwdConflict, sharedCwd: string): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function flattenedWorktreeName(runId: string, index: number): string {
	return `${runId}-${index}`.replaceAll("/", "+");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `worktree-${flattenedWorktreeName(runId, index)}`;
}

function buildWorktreePath(mainRoot: string, runId: string, index: number): string {
	return path.join(mainRoot, ".atomic", "worktrees", flattenedWorktreeName(runId, index));
}

async function ensureWorktreeIgnore(mainRoot: string): Promise<void> {
	const worktreesRoot = path.join(mainRoot, ".atomic", "worktrees");
	await mkdir(worktreesRoot, { recursive: true });
	await writeFile(path.join(worktreesRoot, ".gitignore"), "*\n", "utf8");
}

async function resolveRepoCwdRelative(cwd: string): Promise<string> {
	const repoCheck = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = (await runGitChecked(cwd, ["rev-parse", "--show-prefix"])).trim();
	const normalizedPrefix = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export async function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): Promise<string> {
	const cwdRelative = await resolveRepoCwdRelative(cwd);
	const toplevel = path.resolve((await runGitChecked(cwd, ["rev-parse", "--show-toplevel"])).trim());
	const mainRoot = await findCanonicalGitRoot(toplevel);
	if (mainRoot === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
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

async function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): Promise<ResolvedWorktreeSetupHook | undefined> {
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

	if (!(await pathExists(resolvedPath))) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if ((await stat(resolvedPath)).isDirectory()) {
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

async function hasTrackedEntries(worktreePath: string, relativePath: string): Promise<boolean> {
	const result = await runGit(worktreePath, ["ls-files", "--", relativePath]);
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

/**
 * Whether a hook run's error is only the parent's stdin write losing its reader.
 *
 * A setup hook is handed its JSON input on stdin, but nothing requires a hook to
 * read it and most do not. When such a hook exits before that write is flushed,
 * the write fails with EPIPE even though the hook itself ran to completion — a
 * race a loaded machine loses far more often than an idle one. Node still
 * reports the child's real exit status and full stdout in that case, so the
 * spawn result stays authoritative and only a spawn that never produced a status
 * is a genuine failure.
 */
export function isSpuriousHookStdinWriteFailure(code: string | undefined, status: number | null): boolean {
	return code === "EPIPE" && status !== null;
}

async function runWorktreeSetupHook(hook: ResolvedWorktreeSetupHook, input: WorktreeSetupHookInput): Promise<string[]> {
	const result = await spawnCollect(hook.hookPath, [], {
		cwd: input.worktreePath,
		input: JSON.stringify(input),
		// A hook that installs dependencies can log past the default 1 MiB cap, which kills it mid-run (#4876).
		maxBuffer: HOOK_OUTPUT_MAX_BUFFER,
		env: createChildProcessEnvironment(),
		timeout: hook.timeoutMs,
	});

	if (result.error) {
		const code = "code" in result.error && typeof result.error.code === "string" ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		if (!isSpuriousHookStdinWriteFailure(code, result.status)) {
			throw new Error(`worktree setup hook failed: ${result.error.message}`);
		}
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
		if (await hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

const GIT_LOCK_RELEASE_WAIT_MS = 100;

/**
 * Unlink Atomic's links inside a worktree (the `node_modules` link and other
 * synthetic links) without following them. On Windows the link is a directory
 * junction: current Git for Windows refuses to descend into it during
 * `git worktree remove --force` and leaves the worktree directory behind while
 * exiting 0, and older releases follow it and delete the main checkout's copy.
 */
async function unlinkWorktreeLinks(worktreePath: string, relativePaths: readonly string[]): Promise<void> {
	for (const relativePath of new Set(relativePaths)) {
		const target = path.resolve(worktreePath, relativePath);
		const relative = path.relative(worktreePath, target);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		// Stop at the first link: a link above the target would redirect the unlink outside the worktree.
		let current = worktreePath;
		for (const component of relative.split(path.sep)) {
			current = path.join(current, component);
			let entry: Stats;
			try {
				entry = await lstat(current);
			} catch (error) {
				// Only a missing path is safe to skip; any other inspection failure must
				// keep the worktree out of `git worktree remove --force`.
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") break;
				throw error;
			}
			if (!entry.isSymbolicLink()) continue;
			if (current === target) await unlink(current);
			break;
		}
	}
}

async function cleanupSingleWorktree(
	repoCwd: string,
	worktree: Pick<WorktreeInfo, "path" | "branch">,
	linkPaths: readonly string[],
): Promise<void> {
	try {
		await unlinkWorktreeLinks(worktree.path, linkPaths);
	} catch {
		// A link that cannot be inspected or unlinked must not reach `git worktree remove --force`,
		// which may follow it into the main checkout; leave the worktree for recovery.
		return;
	}
	try {
		await runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		// Cleanup is idempotent and best-effort.
	}
	await sleep(GIT_LOCK_RELEASE_WAIT_MS);
	try {
		await runGitChecked(repoCwd, ["branch", "-D", worktree.branch]);
	} catch {
		// Cleanup is idempotent and best-effort.
	}
}

async function createSingleWorktree(
	mainRoot: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseRef: string,
	baseCommit: string,
	symlinkDirectories: readonly string[],
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): Promise<WorktreeInfo> {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(mainRoot, runId, index);
	const add = await runGit(mainRoot, ["worktree", "add", "-B", branch, worktreePath, baseRef]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		await cleanupSingleWorktree(mainRoot, { path: worktreePath, branch }, []);
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	const syntheticPaths: string[] = [];
	const warnings: string[] = [];
	try {
		syntheticPaths.push(...(await performPostCreationSetup(mainRoot, worktreePath, symlinkDirectories, warnings)));
		if (setupHook) {
			const hookSyntheticPaths = await runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: mainRoot,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}
		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked: syntheticPaths.includes("node_modules"),
			syntheticPaths,
			...(warnings.length > 0 ? { setupWarnings: warnings } : {}),
		};
	} catch (error) {
		// Setup can throw after linking a configured directory but before reporting it.
		await cleanupSingleWorktree(mainRoot, { path: worktreePath, branch }, [...syntheticPaths, ...symlinkDirectories]);
		throw error;
	}
}

export async function createWorktrees(
	cwd: string,
	runId: string,
	count: number,
	options?: CreateWorktreesOptions,
): Promise<WorktreeSetup> {
	const repo = await resolveRepoState(cwd, options?.baseBranch);
	await ensureWorktreeIgnore(repo.mainRoot);
	const setupHook = await resolveWorktreeSetupHook(repo.mainRoot, options?.setupHook);
	const symlinkDirectories = options?.symlinkDirectories ?? ["node_modules"];
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(
				await createSingleWorktree(
					repo.mainRoot,
					repo.cwdRelative,
					runId,
					index,
					repo.baseRef,
					repo.baseCommit,
					symlinkDirectories,
					setupHook,
					options?.agents?.[index],
				),
			);
		}
	} catch (error) {
		await cleanupWorktrees({ cwd: repo.mainRoot, worktrees, baseCommit: repo.baseCommit });
		throw error;
	}

	return { cwd: repo.mainRoot, worktrees, baseCommit: repo.baseCommit };
}

/** Remove the worktrees, except one whose last diff capture failed: it is kept with its work for the user (#4876). */
export async function cleanupWorktrees(setup: WorktreeSetup): Promise<void> {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		const worktree = setup.worktrees[index]!;
		if (worktreeDiffCaptureFailed(worktree.path)) continue;
		await cleanupSingleWorktree(setup.cwd, worktree, worktree.syntheticPaths);
	}
}
