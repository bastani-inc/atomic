import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	containProcessTree,
	createChildProcessEnvironment,
	createGitEnvironment,
	isPathInside,
	killChildProcessTree,
	markDetachedChildExited,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "@bastani/atomic";
import { asyncScope } from "../../shared/async-scope.js";
import { pathExists } from "../../shared/path-exists.js";
import { performPostCreationSetup } from "./worktree-post-create.js";
import { findCanonicalGitRoot } from "./worktree-root.js";
export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}
export interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
	/** Setup steps that could not be done, such as copying `.worktreeinclude` files; the worktree works without them. */
	setupWarnings?: string[];
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
	/** The worktree the diff was captured from. */
	worktreePath: string;
	/** Why the diff could not be captured; the worktree is then kept with its work (#4876). */
	captureError?: string;
	/** The worktree's setup warnings. */
	setupWarnings?: string[];
}
interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}
export interface WorktreeSetupHookConfig {
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
}
interface RepoState {
	mainRoot: string;
	cwdRelative: string;
	baseCommit: string;
	baseRef: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;
/**
 * Node and Bun cap `spawnSync` output at 1 MiB by default; status, ls-files and numstat output of a large change can
 * exceed it (#4876). Patches never go through this buffer: git writes them to the patch file itself.
 */
const GIT_OUTPUT_MAX_BUFFER = 512 * 1024 * 1024;
const HOOK_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const C_GIT_LOCALE_ENV: NodeJS.ProcessEnv = { LC_ALL: "C", LANGUAGE: "C" };

interface SpawnCollectOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	maxBuffer: number;
	timeout?: number;
	shell?: boolean;
}
interface SpawnCollectResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error & { code?: string };
}
function spawnCollect(command: string, args: string[], options: SpawnCollectOptions): Promise<SpawnCollectResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.env !== undefined ? { env: options.env } : {}),
			...(options.shell !== undefined ? { shell: options.shell } : {}),
			// Setup hooks keep their native timeout. A stalled check's timeout below stops the entire git process tree.
			...(options.timeout !== undefined && !stalledCheck.getStore() ? { timeout: options.timeout } : {}),
			stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const tree = child.pid === undefined || child.pid === process.pid ? undefined : containProcessTree(child.pid);
		const detachedPid =
			process.platform !== "win32" && child.pid !== undefined && child.pid !== process.pid ? child.pid : undefined;
		if (detachedPid !== undefined) trackDetachedChildPid(detachedPid);
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let spawnError: (Error & { code?: string }) | undefined;
		let inputError: (Error & { code?: string }) | undefined;
		let timedOut = false;
		let settled = false;
		let exited = false;
		let stopped = false;
		let treeTerminated = false;
		const finish = (status: number | null) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (
				status === null &&
				!spawnError &&
				options.timeout !== undefined &&
				Date.now() - startedAt >= options.timeout
			) {
				timedOut = true;
				spawnError = Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: "ETIMEDOUT" });
			}
			if (!stopped && !spawnError) tree?.release();
			tree?.close();
			if (detachedPid !== undefined) untrackDetachedChildPid(detachedPid);
			const reported = spawnError ?? inputError;
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
				status: timedOut ? null : status,
				...(reported ? { error: reported } : {}),
			});
		};
		const stop = (error: Error & { code?: string }, isTimeout = false) => {
			stopped = true;
			if (isTimeout) timedOut = true;
			spawnError ??= error;
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			// Terminating the tree ends every process in it, and closing it ends any left: it is terminated at most once.
			if (!treeTerminated) treeTerminated = tree?.terminate() === true;
			if (!treeTerminated) killChildProcessTree(child, exited);
			if (exited || child.pid === undefined) finish(null);
		};
		const timer =
			options.timeout !== undefined
				? setTimeout(() => {
						stop(Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: "ETIMEDOUT" }), true);
					}, options.timeout)
				: undefined;
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			stdoutBytes += buf.length;
			if (stdoutBytes <= options.maxBuffer) {
				stdoutChunks.push(buf);
			} else if (!spawnError) {
				stop(Object.assign(new Error(`spawn ${command} ENOBUFS`), { code: "ENOBUFS" }));
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			stderrBytes += buf.length;
			if (stderrBytes <= options.maxBuffer) {
				stderrChunks.push(buf);
			} else if (!spawnError) {
				stop(Object.assign(new Error(`spawn ${command} ENOBUFS`), { code: "ENOBUFS" }));
			}
		});
		child.on("error", (error: Error & { code?: string }) => {
			spawnError ??= error;
			if (child.pid === undefined) finish(null);
		});
		if (options.input !== undefined && child.stdin && !child.stdin.destroyed) {
			child.stdin.on("error", (error: Error & { code?: string }) => {
				inputError ??= error;
			});
			child.stdin.end(options.input);
		}
		child.on("exit", (code, signal) => {
			exited = true;
			if (detachedPid !== undefined) markDetachedChildExited(detachedPid);
			if (
				!spawnError &&
				signal !== null &&
				options.timeout !== undefined &&
				Date.now() - startedAt >= options.timeout
			) {
				stop(Object.assign(new Error(`spawn ${command} ETIMEDOUT`), { code: "ETIMEDOUT" }), true);
			}
			if (stopped) finish(code);
		});
		child.on("close", (code) => {
			finish(code);
		});
	});
}

/**
 * Only a failed resume's read-only check of its own worktree gets this deadline: never a capture, a removal, an initial
 * checkout, a setup hook or a user's fetch, which run to completion however long they take.
 */
const STALLED_CHECK_GIT_TIMEOUT_MS = 10_000;
const stalledCheck = asyncScope<() => void>();
const finishing = asyncScope<boolean>();

/** A filter invoked by a child’s directory cleanup must not wait for that child's terminal notification. */
export function withFinishingWorktree<T>(work: () => T): T {
	return finishing.run(true, work);
}

export async function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
	const onStall = stalledCheck.getStore();
	const gitEnv = createGitEnvironment(
		onStall ? { ...env, GIT_OPTIONAL_LOCKS: "0" } : env,
		createChildProcessEnvironment(),
	);
	// Never inherit a phase from an enclosing filter; it describes only this Git invocation.
	if (finishing.getStore()) gitEnv.ATOMIC_SUBAGENT_WORKTREE_PHASE = "finishing";
	else delete gitEnv.ATOMIC_SUBAGENT_WORKTREE_PHASE;
	const result = await spawnCollect("git", ["-C", cwd, ...args], {
		env: gitEnv,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
		...(onStall && { timeout: STALLED_CHECK_GIT_TIMEOUT_MS }),
	});
	if (onStall && result.error?.code === "ETIMEDOUT") onStall();
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
}
export async function runGitChecked(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	const result = await runGit(cwd, args, env);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}
async function originDefaultBranch(mainRoot: string): Promise<string | undefined> {
	const symbolic = await runGit(mainRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], C_GIT_LOCALE_ENV);
	let branch =
		symbolic.status === 0 && symbolic.stdout.trim().startsWith("origin/")
			? symbolic.stdout.trim().slice("origin/".length)
			: undefined;
	if (!branch) {
		const remote = await runGit(mainRoot, ["remote", "show", "origin"], C_GIT_LOCALE_ENV);
		branch = remote.status === 0 ? remote.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m)?.[1] : undefined;
	}
	if (!branch || branch === "(unknown)") return undefined;
	const remoteRef = `refs/remotes/origin/${branch}`;
	if (
		(await runGit(mainRoot, ["show-ref", "--verify", "--quiet", remoteRef], C_GIT_LOCALE_ENV)).status !== 0 &&
		(await runGit(mainRoot, ["fetch", "origin", `${branch}:${remoteRef}`])).status !== 0
	)
		return undefined;
	return `origin/${branch}`;
}
async function resolveRepoState(cwd: string): Promise<RepoState> {
	const cwdRelative = await resolveRepoCwdRelative(cwd);
	const toplevel = path.resolve((await runGitChecked(cwd, ["rev-parse", "--show-toplevel"], C_GIT_LOCALE_ENV)).trim());
	const mainRoot = await findCanonicalGitRoot(toplevel);
	if (mainRoot === undefined) throw new Error(`unable to resolve canonical main Git repository root from ${toplevel}`);
	const status = await runGitChecked(toplevel, ["status", "--porcelain", "--untracked-files=no"]);
	if (status.trim().length > 0)
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	const baseRef = (await originDefaultBranch(mainRoot)) || "HEAD";
	const baseCommit = (await runGitChecked(mainRoot, ["rev-parse", baseRef], C_GIT_LOCALE_ENV)).trim();
	return { mainRoot, cwdRelative, baseCommit, baseRef };
}
async function normalizeComparableCwd(cwd: string): Promise<string> {
	const resolved = path.resolve(cwd);
	try {
		return await fs.realpath(resolved);
	} catch {
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
function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}
function worktreePatchName(index: number, agent: string, execution: number): string {
	return `task-${index}-${safePatchAgentName(agent)}${execution > 1 ? `.${execution}` : ""}.patch`;
}
/**
 * The patches saved for a child's worktree, oldest first: one per execution of the child, each with every edit since
 * the run's base, so the last one holds all of them.
 */
export async function savedWorktreePatches(diffsDir: string, index: number, agent: string): Promise<string[]> {
	const saved: string[] = [];
	for (let execution = 1; ; execution++) {
		const patchPath = path.join(diffsDir, worktreePatchName(index, agent, execution));
		if (!(await pathExists(patchPath))) return saved;
		saved.push(patchPath);
	}
}
/** Where the next execution of a child saves its worktree's edits, past every patch an earlier execution saved. */
export async function nextWorktreePatchPath(diffsDir: string, index: number, agent: string): Promise<string> {
	return path.join(
		diffsDir,
		worktreePatchName(index, agent, (await savedWorktreePatches(diffsDir, index, agent)).length + 1),
	);
}
/**
 * Put a child's saved edits back into its worktree, recreated at the run's base after it was removed. A worktree not at
 * the base (its branch survived, with its commits) is left as it is. When the edits cannot be applied, the recreated
 * worktree is removed again and the error is thrown: the child must not continue without its earlier work.
 */
export async function restoreWorktreePatch(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	patchPath: string,
): Promise<void> {
	if (!(await fs.readFile(patchPath, "utf-8")).trim()) return;
	if ((await runGitChecked(worktree.path, ["rev-parse", "HEAD"], C_GIT_LOCALE_ENV)).trim() !== setup.baseCommit)
		return;
	const applied = await runGit(worktree.path, ["apply", "--whitespace=nowarn", patchPath]);
	if (applied.status === 0) return;
	await cleanupSingleWorktree(setup.cwd, worktree);
	throw new Error(applied.stderr.trim() || `could not apply ${patchPath}`);
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
export async function ensureWorktreeIgnore(mainRoot: string): Promise<void> {
	const root = path.join(mainRoot, ".atomic", "worktrees");
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, ".gitignore"), "*\n", "utf8");
}
export async function resolveRepoCwdRelative(cwd: string): Promise<string> {
	const repoCheck = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], C_GIT_LOCALE_ENV);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = (await runGitChecked(cwd, ["rev-parse", "--show-prefix"], C_GIT_LOCALE_ENV)).trim();
	const normalizedPrefix = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}
export async function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): Promise<string> {
	const cwdRelative = await resolveRepoCwdRelative(cwd);
	const toplevel = path.resolve((await runGitChecked(cwd, ["rev-parse", "--show-toplevel"], C_GIT_LOCALE_ENV)).trim());
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
	if ((await fs.stat(resolvedPath)).isDirectory()) {
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
	const result = await runGit(worktreePath, ["ls-files", "--", relativePath], C_GIT_LOCALE_ENV);
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
 * Whether a spawn error is only the parent's stdin write losing its reader.
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
		shell: false,
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
async function waitForGitLockRelease(): Promise<void> {
	await delay(100);
}
type RemovableWorktree = Pick<WorktreeInfo, "path"> & { readonly syntheticPaths?: readonly string[] };
/**
 * Unlink the worktree's directory links (the `node_modules` link and the other synthetic links) before git removes it:
 * Git for Windows keeps a junction and every directory above it while reporting success, and older versions delete
 * through a junction into the main checkout.
 */
async function unlinkWorktreeLinks(worktree: RemovableWorktree): Promise<void> {
	for (const relativePath of new Set(["node_modules", ...(worktree.syntheticPaths ?? [])])) {
		const linkPath = path.resolve(worktree.path, relativePath);
		if (!path.relative(worktree.path, linkPath) || !isPathInside(worktree.path, linkPath)) continue;
		try {
			if ((await fs.lstat(linkPath)).isSymbolicLink()) await fs.unlink(linkPath);
		} catch {
			/* absent */
		}
	}
}
async function removeWorktreeCheckout(repoCwd: string, worktree: RemovableWorktree): Promise<void> {
	await unlinkWorktreeLinks(worktree);
	await runGit(repoCwd, ["worktree", "remove", "--force", worktree.path]);
}
async function cleanupSingleWorktree(
	repoCwd: string,
	worktree: RemovableWorktree & Pick<WorktreeInfo, "branch">,
): Promise<void> {
	await removeWorktreeCheckout(repoCwd, worktree);
	await waitForGitLockRelease();
	try {
		await runGitChecked(repoCwd, ["branch", "-D", worktree.branch]);
	} catch {
		/* idempotent */
	}
}
/** Synthetic paths the setup created in a new worktree: copied settings, the `node_modules` link, and hook output. */
async function prepareWorktree(
	mainRoot: string,
	worktreePath: string,
	agentCwd: string,
	branch: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	warnings: string[],
): Promise<string[]> {
	const syntheticPaths = await performPostCreationSetup(runGit, mainRoot, worktreePath, warnings);
	if (setupHook) {
		syntheticPaths.push(
			...(await runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: mainRoot,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			})),
		);
	}
	return syntheticPaths;
}
async function createSingleWorktree(
	mainRoot: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseRef: string,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
): Promise<WorktreeInfo> {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(mainRoot, runId, index);
	const add = await runGit(mainRoot, ["worktree", "add", "-B", branch, worktreePath, baseRef]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		await cleanupSingleWorktree(mainRoot, { path: worktreePath, branch });
		throw new Error(message);
	}
	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	const warnings: string[] = [];
	try {
		const syntheticPaths = await prepareWorktree(
			mainRoot,
			worktreePath,
			agentCwd,
			branch,
			runId,
			index,
			baseCommit,
			setupHook,
			agent,
			warnings,
		);
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
		await cleanupSingleWorktree(mainRoot, { path: worktreePath, branch });
		throw error;
	}
}

/**
 * Recreate a removed child worktree at its path: on its branch when that still exists, else on a new branch from the
 * run's base commit. An existing worktree is kept, and the setup that is safe to repeat (copied settings, the
 * `node_modules` link, included files) is re-applied where it is missing: capturing the worktree's diff removes it.
 * Returns the worktree as it now is.
 */
export async function recreateWorktree(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	runId: string,
	options?: { setupHook?: WorktreeSetupHookConfig; agent?: string },
): Promise<WorktreeInfo> {
	if (await pathExists(worktree.path)) {
		let restored: string[];
		const warnings: string[] = [];
		try {
			restored = await performPostCreationSetup(runGit, setup.cwd, worktree.path, warnings);
		} catch {
			// The worktree itself is intact: the child resumes in it without the setup that could not be re-applied.
			return worktree;
		}
		if (restored.length === 0 && warnings.length === 0) return worktree;
		const syntheticPaths = [...new Set([...worktree.syntheticPaths, ...restored])];
		return {
			...worktree,
			nodeModulesLinked: syntheticPaths.includes("node_modules"),
			syntheticPaths,
			...(warnings.length > 0 ? { setupWarnings: warnings } : {}),
		};
	}
	await runGit(setup.cwd, ["worktree", "prune"]);
	const branchExists =
		(await runGit(setup.cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`], C_GIT_LOCALE_ENV))
			.status === 0;
	await runGitChecked(
		setup.cwd,
		branchExists
			? ["worktree", "add", worktree.path, worktree.branch]
			: ["worktree", "add", "-b", worktree.branch, worktree.path, setup.baseCommit],
	);
	const warnings: string[] = [];
	try {
		const syntheticPaths = await prepareWorktree(
			setup.cwd,
			worktree.path,
			worktree.agentCwd,
			worktree.branch,
			runId,
			worktree.index,
			setup.baseCommit,
			await resolveWorktreeSetupHook(setup.cwd, options?.setupHook),
			options?.agent,
			warnings,
		);
		const { setupWarnings: _earlier, ...recreated } = worktree;
		return {
			...recreated,
			nodeModulesLinked: syntheticPaths.includes("node_modules"),
			syntheticPaths,
			...(warnings.length > 0 ? { setupWarnings: warnings } : {}),
		};
	} catch (error) {
		// A branch that already existed may hold commits: remove only the worktree.
		if (branchExists) await removeWorktreeCheckout(setup.cwd, worktree);
		else await cleanupSingleWorktree(setup.cwd, worktree);
		throw error;
	}
}

/**
 * Whether removing this worktree would lose work: uncommitted or untracked changes other than its synthetic paths, or
 * commits not in the run's base. When git cannot tell, the work is treated as unsaved. With `onStall`, a git command
 * of the check that does not finish within its deadline is stopped with its process tree, and the work is treated as
 * unsaved.
 */
export async function worktreeHasUnsavedWork(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	onStall?: () => void,
): Promise<boolean> {
	if (onStall) return stalledCheck.run(onStall, () => worktreeHasUnsavedWork(setup, worktree));
	if (!(await pathExists(worktree.path))) return false;
	const status = await runGit(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
	if (status.status !== 0) return true;
	const synthetic = worktree.syntheticPaths.map((syntheticPath) => syntheticPath.split(path.sep).join("/"));
	const changed = status.stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => line.slice(3))
		.filter(
			(changedPath) => !synthetic.some((entry) => changedPath === entry || changedPath.startsWith(`${entry}/`)),
		);
	if (changed.length > 0) return true;
	const ahead = await runGit(worktree.path, ["rev-list", "--count", `${setup.baseCommit}..HEAD`], C_GIT_LOCALE_ENV);
	return ahead.status !== 0 || ahead.stdout.trim() !== "0";
}
async function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): Promise<void> {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (
		!relative ||
		relative === "." ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return;
	}
	let stat: Stats;
	try {
		stat = await fs.lstat(resolved);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		await fs.unlink(resolved);
		return;
	}
	if (stat.isDirectory()) {
		await fs.rm(resolved, { recursive: true, force: true });
		return;
	}
	await fs.rm(resolved, { force: true });
}
async function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): Promise<void> {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		await removeSyntheticPath(worktree, syntheticPath);
	}
}
function emptyDiff(worktree: WorktreeInfo, agent: string, patchPath: string): WorktreeDiff {
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		worktreePath: worktree.path,
		...(worktree.setupWarnings?.length ? { setupWarnings: [...worktree.setupWarnings] } : {}),
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
async function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): Promise<WorktreeDiff> {
	await removeSyntheticPathsBeforeDiff(worktree);
	await runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = (await runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit])).trim();
	const numstat = await runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	await writePatchFile(patchPath, (partialPath) =>
		runGitChecked(worktree.path, ["diff", "--cached", "--binary", `--output=${partialPath}`, setup.baseCommit]),
	);
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
		worktreePath: worktree.path,
		...(worktree.setupWarnings?.length ? { setupWarnings: [...worktree.setupWarnings] } : {}),
	};
}
/**
 * Have git write the patch to a file of its own, so no output buffer caps it, and put it at `patchPath` only once it
 * is complete: a failed capture never replaces a patch an earlier capture saved there.
 */
async function writePatchFile(patchPath: string, write: (partialPath: string) => Promise<unknown>): Promise<void> {
	const partialPath = `${patchPath}.${process.pid}.partial`;
	try {
		await write(partialPath);
		await fs.rename(partialPath, patchPath);
	} finally {
		await fs.rm(partialPath, { force: true });
	}
}
/** Worktrees whose last diff capture failed: they hold work no patch has, so they are never removed (#4876). */
const uncapturedWorktrees = new Set<string>();
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}
export async function createWorktrees(
	cwd: string,
	runId: string,
	count: number,
	options?: CreateWorktreesOptions,
): Promise<WorktreeSetup> {
	const repo = await resolveRepoState(cwd);
	await ensureWorktreeIgnore(repo.mainRoot);
	const setupHook = await resolveWorktreeSetupHook(repo.mainRoot, options?.setupHook);
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
/**
 * Save each worktree's edits since the run's base as a patch. `patchPaths` names where a worktree's patch goes when an
 * earlier execution of its child already saved one there.
 */
export async function diffWorktrees(
	setup: WorktreeSetup,
	agents: string[],
	diffsDir: string,
	patchPaths?: ReadonlyMap<number, string>,
): Promise<WorktreeDiff[]> {
	const diffs: WorktreeDiff[] = [];
	for (const worktree of setup.worktrees) {
		const index = worktree.index;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = patchPaths?.get(index) ?? path.join(diffsDir, worktreePatchName(index, agent, 1));
		try {
			await fs.mkdir(path.dirname(patchPath), { recursive: true });
			diffs.push(await captureWorktreeDiff(setup, worktree, agent, patchPath));
			uncapturedWorktrees.delete(worktree.path);
		} catch (error) {
			uncapturedWorktrees.add(worktree.path);
			diffs.push({ ...emptyDiff(worktree, agent, patchPath), captureError: errorMessage(error) });
		}
	}
	return diffs;
}
/** Remove the worktrees, except one whose last diff capture failed: it is kept with its work for the user. */
export async function cleanupWorktrees(setup: WorktreeSetup): Promise<void> {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		const worktree = setup.worktrees[index]!;
		if (uncapturedWorktrees.has(worktree.path)) continue;
		await cleanupSingleWorktree(setup.cwd, worktree);
	}
}
/** A worktree's setup warnings, one line each, naming its task. */
function setupWarningLines(diffs: WorktreeDiff[]): string[] {
	return diffs.flatMap((diff) =>
		(diff.setupWarnings ?? []).map((warning) => `Warning: Task ${diff.index + 1} (${diff.agent}): ${warning}`),
	);
}
export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter((diff) => diff.captureError !== undefined || hasWorktreeChanges(diff));
	const warnings = setupWarningLines(diffs);
	if (changed.length === 0 && warnings.length === 0) return "";
	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		if (diff.captureError !== undefined) {
			lines.push(
				`--- Task ${diff.index + 1} (${diff.agent}): diff capture failed; worktree kept at ${diff.worktreePath} ---`,
				diff.captureError,
				"",
			);
			continue;
		}
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}
	if (changed.length > 0) lines.push(`Full patches: ${path.dirname(changed[0]!.patchPath)}`, "");
	lines.push(...warnings);
	return lines.join("\n").trimEnd();
}
