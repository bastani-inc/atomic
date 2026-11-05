import { spawn } from "node:child_process";
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

const NETWORK_TIMEOUT_MS = 10 * 60_000;
const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_PHASES: ReadonlySet<WorkspaceGitPhase> = new Set(["clone", "fetch", "push"]);
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

/** Run one git command through the configured executable. Cancellation rejects with `signal.reason` unchanged. */
export async function runWorkspaceGit(command: WorkspaceGitCommand): Promise<WorkspaceGitResult> {
	command.signal?.throwIfAborted();
	const git = await executable();
	command.signal?.throwIfAborted();
	for (const observer of observers) observer({ cwd: command.cwd, args: command.args, phase: command.phase });
	const timeoutMs = command.timeoutMs ?? (NETWORK_PHASES.has(command.phase) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
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
	const startedAt = Date.now();
	return new Promise<WorkspaceGitResult>((resolvePromise, reject) => {
		const child = spawn(git.path, argv, { cwd: command.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		// A promise settles once, so a late `close` after an error, abort or timeout changes nothing.
		const settle = (finish: () => void): void => {
			clearTimeout(timer);
			command.signal?.removeEventListener("abort", onAbort);
			finish();
		};
		const onAbort = (): void => {
			child.kill("SIGKILL");
			settle(() => reject(command.signal!.reason));
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle(() =>
				reject(
					new WorkspaceTimeoutError({
						phase: command.phase,
						timeoutMs,
						elapsedMs: Date.now() - startedAt,
						command: commandLabel(command.args),
					}),
				),
			);
		}, timeoutMs);
		command.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			settle(() => {
				if (errnoCode(error) === "ENOENT" && existsSync(command.cwd)) {
					const unavailable = new GitUnavailableError({ gitPath: git.path, cause: error });
					reject(
						new WorkspaceBindingError({
							code: "git-unavailable",
							fields: { gitPath: git.path, installCommand: gitInstallCommand() },
							cause: unavailable,
						}),
					);
					return;
				}
				reject(
					new WorkspaceBindingError({
						code: "git-failed",
						fields: {
							command: commandLabel(command.args),
							cwd: command.cwd,
							phase: command.phase,
							status: null,
							detail: redactCredentials(error.message).slice(0, MAX_DETAIL_LENGTH),
						},
						cause: error,
					}),
				);
			});
		});
		child.on("close", (code) => {
			settle(() => {
				const result = {
					stdout: Buffer.concat(stdout).toString("utf-8"),
					stderr: Buffer.concat(stderr).toString("utf-8"),
					status: code ?? -1,
				};
				if (result.status === 0 || command.allowFailure === true) {
					resolvePromise(result);
					return;
				}
				reject(
					new WorkspaceBindingError({
						code: "git-failed",
						fields: {
							command: commandLabel(command.args),
							cwd: command.cwd,
							phase: command.phase,
							status: result.status,
							detail: redactCredentials(result.stderr.trim() || result.stdout.trim()).slice(
								0,
								MAX_DETAIL_LENGTH,
							),
						},
					}),
				);
			});
		});
	});
}

/** Run a git command and return its trimmed stdout. */
export async function gitOutput(command: WorkspaceGitCommand): Promise<string> {
	return (await runWorkspaceGit(command)).stdout.trim();
}

const availableExecutables = new Map<string, Promise<void>>();

/**
 * Fail fast when git cannot run: one `git --version` per executable per process, before a workspace operation does any
 * other work. A failed check is not remembered, so installing git fixes the next call.
 */
export async function assertWorkspaceGitAvailable(signal?: AbortSignal): Promise<void> {
	const { path } = await executable();
	let check = availableExecutables.get(path);
	if (check === undefined) {
		check = runWorkspaceGit({ cwd: tmpdir(), args: ["--version"], phase: "probe" }).then(() => undefined);
		availableExecutables.set(path, check);
		check.catch(() => availableExecutables.delete(path));
	}
	signal?.throwIfAborted();
	await check;
}
