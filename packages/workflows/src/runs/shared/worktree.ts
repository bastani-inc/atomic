import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@bastani/atomic";
import { normalizeGitRefInput } from "./git-ref.js";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}

interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
}

interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

export interface GitWorktreeSetupOptions {
	gitWorktreeDir: string;
	baseBranch?: string;
	cwd: string;
}

export interface GitWorktreeSetupResult {
	/** Root checkout path that was requested/created/reused. */
	worktreeRoot: string;
	/** Effective workflow cwd, preserving the caller's repo-relative subdirectory inside the worktree. */
	cwd: string;
	/** Invoking checkout root reported by Git. */
	repositoryRoot: string;
	/** Whether this call created a new linked worktree. Existing roots are reused as-is. */
	created: boolean;
}

export type GitWorktreeAcquirer = (options: GitWorktreeSetupOptions) => GitWorktreeSetupResult;

interface ResolvedGitWorktreeInvocation {
	repositoryRoot: string;
	worktreeRoot: string;
	relativeCwd: string;
}

interface AcquiredGitWorktree {
	worktreeRoot: string;
	repositoryRoot: string;
	created: boolean;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;
const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const REUSABLE_WORKTREE_STATUS_ARGS = [
	"status",
	"--porcelain=v1",
	"--untracked-files=all",
	"--ignored=matching",
];
const GIT_LOCAL_ENV_KEYS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_WORK_TREE",
] as const;

function gitCommandEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", [
		"-c",
		`core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`,
		"-c",
		"core.fsmonitor=false",
		...args,
	], {
		cwd,
		encoding: "utf-8",
		env: gitCommandEnv(),
		timeout: 5000,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		...(result.error === undefined ? {} : { error: result.error }),
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function gitFailureMessage(result: GitResult): string {
	if (result.error !== undefined) return result.error.message;
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

function normalizeComparablePath(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function comparableRealPath(value: string): string {
	return normalizeComparablePath(fs.realpathSync.native(value));
}

// Like comparableRealPath, but safe for requested paths that may not exist yet.
function comparableCanonicalPath(value: string): string {
	const resolved = path.resolve(value);
	let current = resolved;
	const missingComponents: string[] = [];
	while (true) {
		try {
			const existing = fs.realpathSync.native(current);
			const canonical = missingComponents.length === 0
				? existing
				: path.join(existing, ...missingComponents.reverse());
			return normalizeComparablePath(canonical);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return normalizeComparablePath(resolved);
			missingComponents.push(path.basename(current));
			current = parent;
		}
	}
}

function gitPathFromOutput(value: string, cwd: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function pathExistsSync(value: string): boolean {
	try {
		fs.statSync(value);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

function repositoryRootForGitWorktree(cwd: string): string {
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) {
		throw new Error(`gitWorktreeDir requires the workflow to be invoked from inside a Git repository. Start from a Git checkout or omit gitWorktreeDir. Git reported: ${gitFailureMessage(result)}`);
	}
	return result.stdout.trim();
}

function gitTopLevel(cwd: string): string | undefined {
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) return undefined;
	return gitPathFromOutput(result.stdout, cwd);
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

function resolveGitWorktreeInvocation(options: GitWorktreeSetupOptions): ResolvedGitWorktreeInvocation {
	const repositoryRoot = repositoryRootForGitWorktree(options.cwd);
	const { relativeCwd, logicalRepoRoot } = cwdWithinGitRepository(options.cwd, repositoryRoot);
	return {
		repositoryRoot,
		worktreeRoot: resolveGitWorktreePath(options.gitWorktreeDir, logicalRepoRoot),
		relativeCwd,
	};
}

function gitWorktreeAcquisitionKey(repositoryRoot: string, worktreeRoot: string): string {
	return `${comparableCanonicalPath(repositoryRoot)}\0${comparableCanonicalPath(worktreeRoot)}`;
}

function worktreeSetupResultForAcquisition(acquired: AcquiredGitWorktree, relativeCwd: string): GitWorktreeSetupResult {
	return {
		worktreeRoot: acquired.worktreeRoot,
		cwd: workspaceCwdForGitWorktreeRoot(acquired.worktreeRoot, relativeCwd),
		repositoryRoot: acquired.repositoryRoot,
		created: acquired.created,
	};
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
	const relative = path.relative(comparableCanonicalPath(parent), comparableCanonicalPath(candidate));
	return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertOutsideInvokingCheckout(worktreeRoot: string, repoRoot: string): void {
	if (!isSameOrDescendantPath(worktreeRoot, repoRoot)) return;
	throw new Error([
		"gitWorktreeDir must be a separate reusable Git worktree root outside the invoking checkout.",
		"Omit gitWorktreeDir to run in primary-checkout fail-closed mode, or provide a sibling/out-of-tree linked worktree path.",
	].join(" "));
}

function dirtyStatusSummary(worktreeRoot: string): string {
	const result = runGit(worktreeRoot, REUSABLE_WORKTREE_STATUS_ARGS);
	if (result.status !== 0) {
		throw new Error(`Failed to inspect gitWorktreeDir cleanliness at ${worktreeRoot}: ${gitFailureMessage(result)}`);
	}
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, 20)
		.join("\n");
}

function assertReusableWorktreeClean(worktreeRoot: string): void {
	const summary = dirtyStatusSummary(worktreeRoot);
	if (summary.length === 0) return;
	throw new Error([
		`gitWorktreeDir already exists but is not clean: ${worktreeRoot}`,
		"Reusable worktrees must have no staged, tracked, untracked, or ignored files before Atomic can own reset/clean rollback.",
		"Clean, stash, or remove those files, or provide a new gitWorktreeDir.",
		`Dirty status:\n${summary}`,
	].join("\n"));
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
	const {
		repositoryRoot: repoRoot,
		relativeCwd,
		worktreeRoot,
	} = resolveGitWorktreeInvocation(options);
	assertOutsideInvokingCheckout(worktreeRoot, repoRoot);
	if (pathExistsSync(worktreeRoot)) {
		validateExistingGitWorktreeRoot(worktreeRoot, repoRoot);
		assertReusableWorktreeClean(worktreeRoot);
		return worktreeSetupResultForAcquisition({
			worktreeRoot,
			repositoryRoot: repoRoot,
			created: false,
		}, relativeCwd);
	}

	try {
		fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to create parent directory for requested gitWorktreeDir ${worktreeRoot}: ${message}`);
	}
	const baseRef = normalizeGitRefInput(options.baseBranch, "HEAD");
	const result = runGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseRef]);
	if (result.status !== 0) {
		throw new Error([
			`Failed to create git worktree at requested gitWorktreeDir ${worktreeRoot} from ${baseRef}. Git reported: ${gitFailureMessage(result)}`,
			`If another process just created this same-repository worktree, rerun the workflow to resume it. If this is an orphaned worktree from an interrupted run, recover or remove it with: ${worktreeRecoveryCommand(repoRoot, worktreeRoot)}`,
		].join("\n"));
	}
	return worktreeSetupResultForAcquisition({
		worktreeRoot,
		repositoryRoot: repoRoot,
		created: true,
	}, relativeCwd);
}

/**
 * Internal executor helper: acquire reusable git worktrees once per workflow run.
 *
 * The first acquisition intentionally delegates to setupGitWorktree() so all
 * fail-closed direct-call safety checks (primary checkout rejection, same-repo
 * validation, and existing-worktree cleanliness) remain unchanged. Later
 * acquisitions in the same workflow run are workflow-owned and only reuse the
 * cached identity while recomputing cwd for the caller's current repo-relative
 * invocation directory.
 */
export function createRunScopedGitWorktreeAcquirer(): GitWorktreeAcquirer {
	const acquiredByKey = new Map<string, AcquiredGitWorktree>();

	return (options: GitWorktreeSetupOptions): GitWorktreeSetupResult => {
		const invocation = resolveGitWorktreeInvocation(options);
		const requestedKey = gitWorktreeAcquisitionKey(invocation.repositoryRoot, invocation.worktreeRoot);
		const cached = acquiredByKey.get(requestedKey);
		if (cached !== undefined) {
			return worktreeSetupResultForAcquisition(cached, invocation.relativeCwd);
		}

		const setup = setupGitWorktree(options);
		const acquired: AcquiredGitWorktree = {
			worktreeRoot: setup.worktreeRoot,
			repositoryRoot: setup.repositoryRoot,
			created: setup.created,
		};
		const acquiredKey = gitWorktreeAcquisitionKey(setup.repositoryRoot, setup.worktreeRoot);
		acquiredByKey.set(acquiredKey, acquired);
		acquiredByKey.set(requestedKey, acquired);
		return setup;
	};
}

function resolveRepoState(cwd: string): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

	const status = runGitChecked(toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
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

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `${APP_NAME}-parallel-${runId}-${index}`;
}

function buildWorktreePath(runId: string, index: number): string {
	return path.join(os.tmpdir(), `${APP_NAME}-worktree-${runId}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const worktreePath = buildWorktreePath(runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
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

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
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
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo): void {
	try { runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
	try { runGitChecked(repoCwd, ["branch", "-D", worktree.branch]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
			));
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
		});
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch {
			// Preserve execution flow; failed diff capture maps to an empty per-task patch.
			writeEmptyPatch(patchPath);
			diffs.push(emptyDiff(index, agent, worktree.branch, patchPath));
		}
	}

	return diffs;
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		cleanupSingleWorktree(setup.cwd, setup.worktrees[index]!);
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch {
		// Pruning is best-effort cleanup.
	}
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
