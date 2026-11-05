import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { createGitEnvironment } from "../../utils/git-env.ts";
import {
	GitUnavailableError,
	gitInstallCommand,
	isGitUnavailableError,
	WorkspaceBindingError,
	type WorkspaceGitPhase,
	WorkspaceTimeoutError,
} from "./errors.ts";
import { runWorkspaceProcess, waitFor } from "./process.ts";
import { redactCredentials } from "./redact.ts";

/** The git executable every workspace git command runs, and the environment it needs. */
export interface WorkspaceGitExecutable {
	readonly path: string;
	readonly env: Readonly<Record<string, string>>;
}

export type WorkspaceGitExecutableResolver = () => Promise<WorkspaceGitExecutable>;

const SYSTEM_GIT: WorkspaceGitExecutableResolver = async () => ({ path: "git", env: {} });
let resolveExecutable: WorkspaceGitExecutableResolver = SYSTEM_GIT;

/**
 * The single injection point for the git executable used by workspace bindings. Defaults to `git` on PATH.
 * Returns a function that restores the previous resolver.
 */
export function setWorkspaceGitExecutableResolver(resolver: WorkspaceGitExecutableResolver): () => void {
	const previous = resolveExecutable;
	resolveExecutable = resolver;
	return () => {
		resolveExecutable = previous;
	};
}

export interface WorkspaceGitCommand {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly phase: WorkspaceGitPhase;
	readonly signal?: AbortSignal;
	/** Extra environment for this command only, applied after repository-local variables are cleared. */
	readonly env?: Readonly<Record<string, string>>;
	/** Return a non-zero exit instead of throwing `git-failed`. */
	readonly allowFailure?: boolean;
	readonly timeoutMs?: number;
	/** Called with git's pid once it started; a throw stops git and fails the command. */
	readonly onSpawn?: (pid: number) => void;
}

export interface WorkspaceGitResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number;
}

export type WorkspaceGitObserver = (command: {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly phase: WorkspaceGitPhase;
}) => void;

const observers = new Set<WorkspaceGitObserver>();

/** Internal counting seam: observe every workspace git command before it starts. */
export function observeWorkspaceGitCommands(observer: WorkspaceGitObserver): () => void {
	observers.add(observer);
	return () => observers.delete(observer);
}

const LONG_TIMEOUT_MS = 10 * 60_000;
const LOCAL_TIMEOUT_MS = 60_000;
/** Network transfers and checkouts can take minutes on a large repository; other steps are local and quick. */
const LONG_PHASES: ReadonlySet<WorkspaceGitPhase> = new Set(["clone", "fetch", "push", "worktree-add"]);
const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const WINDOWS_LONG_PATHS: readonly string[] = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
const MAX_DETAIL_LENGTH = 400;

function commandLabel(args: readonly string[]): string {
	return redactCredentials(["git", ...args].join(" "));
}

function errnoCode(error: Error): string | undefined {
	const code = (error as Error & { readonly code?: string }).code;
	return typeof code === "string" ? code : undefined;
}

async function executable(): Promise<WorkspaceGitExecutable> {
	try {
		return await resolveExecutable();
	} catch (error) {
		if (isGitUnavailableError(error))
			throw new WorkspaceBindingError({
				code: "git-unavailable",
				fields: { gitPath: String(error.fields.gitPath), installCommand: gitInstallCommand() },
				cause: error,
			});
		throw error;
	}
}

/**
 * Run one git command through the configured executable. Cancellation and timeouts stop git and wait for it to exit,
 * so whatever it removes on the way out is gone before the call fails; cancellation rejects with `signal.reason`.
 */
export async function runWorkspaceGit(command: WorkspaceGitCommand): Promise<WorkspaceGitResult> {
	command.signal?.throwIfAborted();
	const git = await executable();
	command.signal?.throwIfAborted();
	for (const observer of observers) observer({ cwd: command.cwd, args: command.args, phase: command.phase });
	const timeoutMs = command.timeoutMs ?? (LONG_PHASES.has(command.phase) ? LONG_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
	const argv = [
		"-c",
		`core.hooksPath=${DISABLED_HOOKS_PATH}`,
		"-c",
		"core.fsmonitor=false",
		...WINDOWS_LONG_PATHS,
		...command.args,
	];
	const env = {
		...createGitEnvironment(
			{ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...git.env },
			createChildProcessEnvironment(),
		),
		...command.env,
	};
	const outcome = await runWorkspaceProcess({
		path: git.path,
		args: argv,
		cwd: command.cwd,
		env,
		signal: command.signal,
		timeoutMs,
		timeoutError: (elapsedMs) =>
			new WorkspaceTimeoutError({ phase: command.phase, timeoutMs, elapsedMs, command: commandLabel(command.args) }),
		onSpawn: command.onSpawn,
	});
	if (outcome.kind === "not-started") {
		const error = outcome.error;
		if (errnoCode(error) === "ENOENT" && existsSync(command.cwd))
			throw new WorkspaceBindingError({
				code: "git-unavailable",
				fields: { gitPath: git.path, installCommand: gitInstallCommand() },
				cause: new GitUnavailableError({ gitPath: git.path, cause: error }),
			});
		throw new WorkspaceBindingError({
			code: "git-failed",
			fields: {
				command: commandLabel(command.args),
				cwd: command.cwd,
				phase: command.phase,
				status: null,
				detail: redactCredentials(error.message).slice(-MAX_DETAIL_LENGTH),
			},
			cause: error,
		});
	}
	const result = { stdout: outcome.stdout, stderr: outcome.stderr, status: outcome.status ?? -1 };
	if (result.status === 0 || command.allowFailure === true) return result;
	throw new WorkspaceBindingError({
		code: "git-failed",
		fields: {
			command: commandLabel(command.args),
			cwd: command.cwd,
			phase: command.phase,
			status: result.status,
			detail: redactCredentials(result.stderr.trim() || result.stdout.trim()).slice(-MAX_DETAIL_LENGTH),
		},
	});
}

/** Run a git command and return its trimmed stdout. */
export async function gitOutput(command: WorkspaceGitCommand): Promise<string> {
	return (await runWorkspaceGit(command)).stdout.trim();
}

const availableExecutables = new Map<string, Promise<void>>();

/** The oldest git whose `worktree add` takes `--lock --reason`, which marks a worktree while it is added. */
const MINIMUM_GIT_VERSION = [2, 33] as const;

function assertSupportedVersion(gitPath: string, versionOutput: string): void {
	const match = /git version (\d+)\.(\d+)(\S*)/.exec(versionOutput);
	if (match === null) return;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const [minimumMajor, minimumMinor] = MINIMUM_GIT_VERSION;
	if (major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)) return;
	throw new WorkspaceBindingError({
		code: "git-unavailable",
		reason: "outdated",
		fields: {
			gitPath,
			version: `${major}.${minor}${match[3]}`,
			minimumVersion: MINIMUM_GIT_VERSION.join("."),
			installCommand: gitInstallCommand(),
		},
	});
}

/**
 * Fail fast when git cannot run or is too old: one `git --version` per executable per process, before a workspace
 * operation does any other work. A failed check is not remembered, so installing git fixes the next call.
 */
export async function assertWorkspaceGitAvailable(signal?: AbortSignal): Promise<void> {
	const { path } = await executable();
	let check = availableExecutables.get(path);
	if (check === undefined) {
		check = runWorkspaceGit({ cwd: tmpdir(), args: ["--version"], phase: "probe" }).then((result) =>
			assertSupportedVersion(path, result.stdout),
		);
		availableExecutables.set(path, check);
		check.catch(() => availableExecutables.delete(path));
	}
	await waitFor(check, signal);
}
