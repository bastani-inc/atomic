import { spawnSync } from "node:child_process";
import { createGitEnvironment } from "@bastani/atomic";
import type { GitResult } from "./worktree-types.js";

const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_COMMAND_TIMEOUT_MS = 60_000;
const GIT_READ_ONLY_PROBE_TIMEOUT_ATTEMPTS = 2;
export type GitRunner = (cwd: string, args: readonly string[]) => GitResult;
let gitRunnerOverride: GitRunner | undefined;

function gitCommandArgs(args: readonly string[]): string[] {
	return ["-c", `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, "-c", "core.fsmonitor=false", ...args];
}
function gitCommandArgv(args: readonly string[]): string[] { return ["git", ...gitCommandArgs(args)]; }
function withDiagnostics(result: GitResult, cwd: string, args: readonly string[]): GitResult {
	return { ...result, argv: result.argv ?? gitCommandArgv(args), cwd: result.cwd ?? cwd, timeoutMs: result.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS };
}
function spawnGit(cwd: string, args: readonly string[], plain: boolean): GitResult {
	const startedAt = Date.now();
	const result = spawnSync("git", plain ? args : gitCommandArgs(args), {
		cwd,
		encoding: "utf-8",
		env: createGitEnvironment({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
		timeout: GIT_COMMAND_TIMEOUT_MS,
	});
	return {
		stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? null,
		signal: result.signal ?? null, elapsedMs: Math.max(0, Date.now() - startedAt),
		...(result.error === undefined ? {} : { error: result.error }),
	};
}
export function withGitRunnerForTest<T>(runner: GitRunner, callback: () => T): T {
	const previous = gitRunnerOverride;
	gitRunnerOverride = runner;
	try { return callback(); } finally { gitRunnerOverride = previous; }
}
export function runGit(cwd: string, args: readonly string[]): GitResult {
	return withDiagnostics((gitRunnerOverride ?? ((dir, values) => spawnGit(dir, values, false)))(cwd, args), cwd, args);
}
/** Run Git without command-line config overrides; used only for shared config. */
export function runGitPlain(cwd: string, args: readonly string[]): GitResult {
	const result = (gitRunnerOverride ?? ((dir, values) => spawnGit(dir, values, true)))(cwd, args);
	return { ...withDiagnostics(result, cwd, args), argv: result.argv ?? ["git", ...args] };
}
export function runGitChecked(cwd: string, args: readonly string[]): string {
	const result = runGit(cwd, args);
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
		if (isGitTimeoutResult(result)) return `git command timed out after ${result.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS}ms${code === undefined ? "" : ` (${code})`}: ${result.error.message}${diagnosticSuffix(result)}`;
		return `${code === undefined ? result.error.message : `${code}: ${result.error.message}`}${diagnosticSuffix(result)}`;
	}
	return `${result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.status}`}${diagnosticSuffix(result)}`;
}
export function runGitReadOnlyProbe(cwd: string, args: readonly string[]): GitResult {
	let attempts = 1;
	let result = runGit(cwd, args);
	while (attempts < GIT_READ_ONLY_PROBE_TIMEOUT_ATTEMPTS && result.status !== 0 && isGitTimeoutResult(result)) {
		attempts += 1;
		result = runGit(cwd, args);
	}
	return attempts > 1 ? { ...result, attempts } : result;
}
