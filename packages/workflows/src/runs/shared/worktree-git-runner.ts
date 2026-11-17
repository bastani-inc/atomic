import { spawnSync } from "node:child_process";
import {
	createChildProcessEnvironment,
	createGitEnvironment,
	isGitProvisionError,
	isGitUnavailableError,
	isRetryableGitProvisionError,
	resolveGit,
	resolveGitSync,
	resolveInstalledGit,
} from "@bastani/atomic";
import { type WorkflowGitRequiredFields, wrapGitRequired } from "../../shared/workflow-git-required-error.js";
import { spawnCollect } from "./spawn-collect.js";
import type { GitResult } from "./worktree-types.js";

const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_COMMAND_TIMEOUT_MS = 60_000;
/**
 * Node and Bun cap `spawnSync` output at 1 MiB by default; ls-files, status and numstat output in a large repository or
 * change can exceed it (#4876). Patches never go through this buffer: git writes them to the patch file itself. Git run
 * without blocking gets the same cap.
 */
const GIT_OUTPUT_MAX_BUFFER = 512 * 1024 * 1024;
export type GitRunner = (cwd: string, args: readonly string[]) => GitResult;
let gitRunnerOverride: GitRunner | undefined;

function gitCommandArgs(args: readonly string[]): string[] {
	return ["-c", `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, "-c", "core.fsmonitor=false", ...args];
}
function gitCommandArgv(args: readonly string[]): string[] {
	return ["git", ...gitCommandArgs(args)];
}
export function withDiagnostics(result: GitResult, cwd: string, args: readonly string[]): GitResult {
	return {
		...result,
		argv: result.argv ?? gitCommandArgv(args),
		cwd: result.cwd ?? cwd,
		timeoutMs: result.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
	};
}
function gitEnvironment(gitEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return createGitEnvironment(
		{ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
		createChildProcessEnvironment(undefined, gitEnv),
	);
}
/** Runs git and waits for it, for the synchronous `setupGitWorktree` of the SDK only; the engine runs {@link spawnGit}. */
function spawnGitSync(cwd: string, args: readonly string[]): GitResult {
	const git = resolveGitSync();
	const startedAt = Date.now();
	const result = spawnSync(git.path, gitCommandArgs(args), {
		cwd,
		encoding: "utf-8",
		env: gitEnvironment(git.env),
		timeout: GIT_COMMAND_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? null,
		signal: result.signal ?? null,
		elapsedMs: Math.max(0, Date.now() - startedAt),
		...(result.error === undefined ? {} : { error: result.error }),
	};
}
async function spawnGit(cwd: string, args: readonly string[], plain: boolean): Promise<GitResult> {
	const git = await resolveInstalledGit();
	const startedAt = Date.now();
	const result = await spawnCollect(git.path, plain ? args : gitCommandArgs(args), {
		cwd,
		env: gitEnvironment(git.env),
		timeout: GIT_COMMAND_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});
	return { ...result, elapsedMs: Math.max(0, Date.now() - startedAt) };
}
/** A git run before its diagnostics are added, synchronously: a test's runner when one is set. */
export function rawGitSync(cwd: string, args: readonly string[]): GitResult {
	return gitRunnerOverride === undefined ? spawnGitSync(cwd, args) : gitRunnerOverride(cwd, args);
}
/** A git run before its diagnostics are added: a test's runner when one is set. */
export async function rawGit(cwd: string, args: readonly string[], plain = false): Promise<GitResult> {
	return gitRunnerOverride === undefined ? await spawnGit(cwd, args, plain) : gitRunnerOverride(cwd, args);
}
/**
 * Provision git before a run's synchronous worktree helpers need it, only for a run whose inputs bind a worktree:
 * it fails here, before any stage starts, with {@link WorkflowGitRequiredError} when git cannot be provided. A run
 * with no worktree input never starts a download.
 */
export async function prepareRunGit(
	signal: AbortSignal,
	request: WorkflowGitRequiredFields | undefined,
): Promise<void> {
	if (request === undefined || gitRunnerOverride !== undefined) return;
	try {
		await resolveGit({ signal });
	} catch (error) {
		throw wrapGitRequired(error, request);
	}
}

/**
 * Give a task that creates its own worktree the chance to download git before its stage starts. Only a missing git
 * that can be downloaded, or a download that failed in a retryable way, is attempted; every other state, and a failed
 * attempt, is left to the stage's live setup, which raises the recorded typed error as `WorkflowGitRequiredError`, so
 * a replayed task that never touches git still completes offline.
 */
export async function prepareTaskGit(signal: AbortSignal): Promise<void> {
	if (gitRunnerOverride !== undefined) return;
	try {
		await resolveInstalledGit();
		return;
	} catch (error) {
		const notInstalled = isGitUnavailableError(error) && error.code === "not-installed";
		if (!isGitProvisionError(error) || !(notInstalled || isRetryableGitProvisionError(error))) return;
	}
	await resolveGit({ signal }).catch((error: unknown) => {
		if (!isGitProvisionError(error)) throw error;
	});
}
/** Runs git through `runner` while `callback` runs, until the promise it returns settles when it returns one. */
export function withGitRunnerForTest<T>(runner: GitRunner, callback: () => T): T {
	const previous = gitRunnerOverride;
	gitRunnerOverride = runner;
	const restore = () => {
		gitRunnerOverride = previous;
	};
	let result: T;
	try {
		result = callback();
	} catch (error) {
		restore();
		throw error;
	}
	if (!(result instanceof Promise)) {
		restore();
		return result;
	}
	return result.finally(restore) as T;
}
export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
	return withDiagnostics(await rawGit(cwd, args), cwd, args);
}
/** Run Git without command-line config overrides; used only for shared config. */
export async function runGitPlain(cwd: string, args: readonly string[]): Promise<GitResult> {
	const result = await rawGit(cwd, args, true);
	return { ...withDiagnostics(result, cwd, args), argv: result.argv ?? ["git", ...args] };
}
export async function runGitChecked(cwd: string, args: readonly string[]): Promise<string> {
	const result = await runGit(cwd, args);
	if (result.status !== 0) throw new Error(gitFailureMessage(result));
	return result.stdout;
}
function gitErrorCode(error: Error): string | undefined {
	return "code" in error ? String((error as Error & { readonly code?: unknown }).code) : undefined;
}
export function isGitTimeoutResult(result: GitResult): boolean {
	if (result.error === undefined) return false;
	const code = gitErrorCode(result.error)?.toUpperCase();
	const message = result.error.message.toLowerCase();
	return code === "ETIMEDOUT" || message.includes("etimedout") || message.includes("timed out");
}
function formatArg(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,\\-]+$/.test(value) ? value : JSON.stringify(value);
}
function diagnosticSuffix(result: GitResult): string {
	const details: string[] = [];
	if (result.argv?.length) details.push(`command: ${result.argv.map(formatArg).join(" ")}`);
	if (result.cwd !== undefined) details.push(`cwd: ${result.cwd}`);
	if (result.timeoutMs !== undefined) details.push(`timeout: ${result.timeoutMs}ms`);
	if (result.elapsedMs !== undefined) details.push(`elapsed: ${result.elapsedMs}ms`);
	details.push(`status: ${result.status === null ? "null" : result.status}`);
	if (result.signal !== undefined) details.push(`signal: ${result.signal ?? "null"}`);
	if (result.attempts !== undefined && result.attempts > 1) details.push(`attempts: ${result.attempts}`);
	return ` (${details.join("; ")})`;
}
export function gitFailureMessage(result: GitResult): string {
	if (result.error !== undefined) {
		const code = gitErrorCode(result.error);
		if (isGitTimeoutResult(result))
			return `git command timed out after ${result.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS}ms${code === undefined ? "" : ` (${code})`}: ${result.error.message}${diagnosticSuffix(result)}`;
		return `${code === undefined ? result.error.message : `${code}: ${result.error.message}`}${diagnosticSuffix(result)}`;
	}
	return `${result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.status}`}${diagnosticSuffix(result)}`;
}
/** How many times a read-only git probe runs when it keeps timing out. */
export const GIT_READ_ONLY_PROBE_TIMEOUT_ATTEMPTS = 2;
