import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getShellConfig, killProcessTree } from "../../utils/shell.ts";
import { computeEnvironmentHash, ENVIRONMENT_INPUT_FILES } from "../worktree-snapshot/env-hash.ts";
import {
	type ResumeEntryPoint,
	ResumePreconditionError,
	type ResumePreconditionProblem,
	ResumeSetupHookError,
} from "./errors.ts";

/** The repository-provided setup hook, relative to the worktree root. Runs only in a trusted project. */
export const RESUME_SETUP_HOOK_FILE = ".atomic/setup";
/** The setting that names a setup command, used when the repository provides no trusted hook. */
export const RESUME_SETUP_COMMAND_SETTING = "resume.setupCommand";
/** How long a setup hook may run before it is stopped and the resume fails. */
export const DEFAULT_RESUME_SETUP_TIMEOUT_MS = 15 * 60_000;

/** How a restored worktree's dependencies are materialized. */
export interface ResumeSetupConfig {
	/** `resume.setupCommand`, run through the shell in the worktree. */
	readonly command?: string;
	/** Whether the project at a worktree is trusted, which `.atomic/setup` requires. */
	readonly trusted: (worktree: string) => boolean;
	readonly timeoutMs?: number;
}

/** The last setup run recorded for one worktree on this host. */
export interface ResumeSetupLedgerEntry {
	readonly worktree: string;
	readonly envHash: string;
	readonly hook: string;
	readonly exitStatus: number | null;
	readonly signal: string | null;
	readonly ranAt: string;
	readonly logPath: string;
}

export type ResumeSetupOutcome =
	| { readonly status: "not-needed" }
	| { readonly status: "ran"; readonly hook: string; readonly logPath: string };

export interface EnsureResumeSetupOptions {
	readonly entryPoint: ResumeEntryPoint;
	/** Root of a worktree Atomic restored on this host. */
	readonly worktree: string;
	/** The environment fingerprint the restored snapshot recorded. */
	readonly envHash: string;
	/** Host directory that holds restored worktrees; the setup ledger and logs live under it. */
	readonly storeDir: string;
	readonly config: ResumeSetupConfig;
	readonly signal?: AbortSignal;
}

function ledgerPath(storeDir: string, worktree: string): string {
	const key = createHash("sha256").update(resolve(worktree)).digest("hex");
	return join(storeDir, "setup-ledger", `${key}.json`);
}

/** The setup run recorded for `worktree`, if any. */
export async function readResumeSetupLedger(
	storeDir: string,
	worktree: string,
): Promise<ResumeSetupLedgerEntry | undefined> {
	try {
		return JSON.parse(await readFile(ledgerPath(storeDir, worktree), "utf8")) as ResumeSetupLedgerEntry;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeLedger(storeDir: string, entry: ResumeSetupLedgerEntry): Promise<void> {
	const path = ledgerPath(storeDir, entry.worktree);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/** Whether `worktree` has any file that decides installed dependencies or toolchains. */
export async function hasEnvironmentInputs(worktree: string): Promise<boolean> {
	for (const path of ENVIRONMENT_INPUT_FILES) {
		if (await isFile(join(worktree, path))) return true;
	}
	return false;
}

type ResolvedHook =
	| { readonly kind: "file"; readonly name: string; readonly path: string }
	| { readonly kind: "command"; readonly name: string; readonly command: string };

async function resolveHook(
	worktree: string,
	config: ResumeSetupConfig,
): Promise<ResolvedHook | "untrusted" | undefined> {
	const file = join(worktree, RESUME_SETUP_HOOK_FILE);
	const present = await isFile(file);
	if (present && config.trusted(worktree)) return { kind: "file", name: RESUME_SETUP_HOOK_FILE, path: file };
	const command = config.command?.trim();
	if (command) return { kind: "command", name: RESUME_SETUP_COMMAND_SETTING, command };
	return present ? "untrusted" : undefined;
}

function missingHookError(options: EnsureResumeSetupOptions, untrusted: boolean): ResumePreconditionError {
	return new ResumePreconditionError({
		entryPoint: options.entryPoint,
		problems: [
			{
				code: "setup-hook-missing",
				subject: untrusted ? `${RESUME_SETUP_HOOK_FILE} (untrusted project)` : "setup hook",
				why: `the worktree restored at ${options.worktree} has dependency inputs (envHash ${options.envHash.slice(0, 12)}) that were never installed on this node, and ${
					untrusted
						? `${RESUME_SETUP_HOOK_FILE} runs only in a trusted project`
						: `neither ${RESUME_SETUP_HOOK_FILE} nor ${RESUME_SETUP_COMMAND_SETTING} is configured`
				}`,
				fix: untrusted
					? `Trust the project (start with --approve, or set "defaultProjectTrust": "always"), or set "${RESUME_SETUP_COMMAND_SETTING}" in ~/.atomic/agent/settings.json, then resume again.`
					: `Add an executable ${RESUME_SETUP_HOOK_FILE} to the repository, or set "${RESUME_SETUP_COMMAND_SETTING}" (for example "npm ci") in ~/.atomic/agent/settings.json, then resume again.`,
			},
		],
	});
}

let noInputsHash: Promise<string> | undefined;

/** The environment fingerprint of a checkout without any dependency input file. */
function noInputsEnvironmentHash(): Promise<string> {
	noInputsHash ??= computeEnvironmentHash(join(tmpdir(), `atomic-no-environment-inputs-${randomUUID()}`));
	return noInputsHash;
}

/**
 * The `setup-hook-missing` problem that restoring a snapshot recorded with `envHash` would hit, when that is known
 * before restoring: the snapshot has dependency inputs, no `resume.setupCommand` is configured, and a worktree restored
 * under `prospectiveWorktree` would not be trusted to run the repository's `.atomic/setup`. Whether the repository has
 * that file is only known after the restore.
 */
export async function predictedSetupProblem(
	envHash: string,
	prospectiveWorktree: string,
	config: ResumeSetupConfig,
): Promise<ResumePreconditionProblem | undefined> {
	if (config.command?.trim()) return undefined;
	if (envHash === (await noInputsEnvironmentHash())) return undefined;
	if (config.trusted(prospectiveWorktree)) return undefined;
	return {
		code: "setup-hook-missing",
		subject: "setup hook",
		why: `the snapshot has dependency inputs (envHash ${envHash.slice(0, 12)}) that a restored worktree must install, no ${RESUME_SETUP_COMMAND_SETTING} is configured, and a restored worktree is not trusted to run ${RESUME_SETUP_HOOK_FILE}`,
		fix: `Set "${RESUME_SETUP_COMMAND_SETTING}" (for example "npm ci") in ~/.atomic/agent/settings.json, or trust restored worktrees (start with --approve, or set "defaultProjectTrust": "always") so the repository's ${RESUME_SETUP_HOOK_FILE} can run, then resume again.`,
	};
}

interface HookExit {
	readonly exitStatus: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly elapsedMs: number;
}

async function runHook(
	hook: ResolvedHook,
	worktree: string,
	envHash: string,
	logPath: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<HookExit> {
	signal?.throwIfAborted();
	await mkdir(dirname(logPath), { recursive: true });
	const log = await open(logPath, "w", 0o600);
	const startedAt = Date.now();
	try {
		return await new Promise<HookExit>((resolveExit, reject) => {
			const child = spawnHook(hook, worktree, log.fd, hookEnv(worktree, envHash));
			let timedOut = false;
			const stop = () => {
				if (child.pid !== undefined) killProcessTree(child.pid);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, timeoutMs);
			const onAbort = () => stop();
			const settle = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			signal?.addEventListener("abort", onAbort);
			child.once("error", (error) => {
				settle();
				reject(error);
			});
			child.once("close", (exitStatus, exitSignal) => {
				settle();
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				resolveExit({ exitStatus, signal: exitSignal, timedOut, elapsedMs: Date.now() - startedAt });
			});
		});
	} finally {
		await log.close();
	}
}

/**
 * Starts `hook` in `worktree` in its own process group (POSIX), so stopping it stops everything it started: the
 * repository's `.atomic/setup` through the configured shell (bash, or Git Bash on Windows, which runs a script by its
 * shebang, or the legacy WSL launcher, which takes the command on stdin), and `resume.setupCommand` through the
 * platform shell.
 */
function spawnHook(hook: ResolvedHook, worktree: string, logFd: number, env: NodeJS.ProcessEnv): ChildProcess {
	const options = { cwd: worktree, detached: process.platform !== "win32", windowsHide: true, env };
	if (hook.kind === "command")
		return spawn(hook.command, { ...options, shell: true, stdio: ["ignore", logFd, logFd] });
	const { shell, args, commandTransport } = getShellConfig();
	const script = `./${RESUME_SETUP_HOOK_FILE}`;
	if (commandTransport !== "stdin")
		return spawn(shell, [...args, script], { ...options, stdio: ["ignore", logFd, logFd] });
	const child = spawn(shell, args, { ...options, stdio: ["pipe", logFd, logFd] });
	child.stdin?.end(script);
	return child;
}

function hookEnv(worktree: string, envHash: string): NodeJS.ProcessEnv {
	return { ...process.env, ATOMIC_ENV_HASH: envHash, ATOMIC_RESUME_WORKTREE: worktree };
}

/**
 * The hook a restored worktree needs before work continues in it, or undefined when it needs none: it has no
 * dependency inputs, or the ledger has a successful run for the recorded `envHash`. Throws
 * {@link ResumePreconditionError} (`setup-hook-missing`) when one is needed and none is available.
 */
async function neededHook(options: EnsureResumeSetupOptions): Promise<ResolvedHook | undefined> {
	const worktree = resolve(options.worktree);
	const ledger = await readResumeSetupLedger(options.storeDir, worktree);
	if (ledger?.envHash === options.envHash && ledger.exitStatus === 0) return undefined;
	if (!(await hasEnvironmentInputs(worktree))) return undefined;
	const hook = await resolveHook(worktree, options.config);
	if (hook === undefined || hook === "untrusted") throw missingHookError(options, hook === "untrusted");
	return hook;
}

/**
 * Checks, without running anything, that a restored worktree has the setup hook it needs: throws
 * {@link ResumePreconditionError} (`setup-hook-missing`) exactly when {@link ensureResumeSetup} would.
 */
export async function assertResumeSetupAvailable(options: EnsureResumeSetupOptions): Promise<void> {
	await neededHook(options);
}

/**
 * Runs the setup hook a restored worktree needs before work continues in it, and records the result in the host's
 * setup ledger. The hook is needed when the worktree has dependency inputs and the ledger has no successful run for
 * the recorded `envHash`, so a worktree is set up once per environment. Throws {@link ResumePreconditionError}
 * (`setup-hook-missing`) when no hook is available, and {@link ResumeSetupHookError} when it fails or times out.
 */
export async function ensureResumeSetup(options: EnsureResumeSetupOptions): Promise<ResumeSetupOutcome> {
	const worktree = resolve(options.worktree);
	const hook = await neededHook(options);
	if (hook === undefined) return { status: "not-needed" };
	const timeoutMs = options.config.timeoutMs ?? DEFAULT_RESUME_SETUP_TIMEOUT_MS;
	const logPath = join(
		options.storeDir,
		"setup-logs",
		`${createHash("sha256").update(worktree).digest("hex").slice(0, 12)}-${Date.now()}.log`,
	);
	let exit: HookExit;
	try {
		exit = await runHook(hook, worktree, options.envHash, logPath, timeoutMs, options.signal);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new ResumeSetupHookError(
			"setup-hook-failed",
			{
				hook: hook.name,
				worktree,
				envHash: options.envHash,
				exitStatus: null,
				signal: null,
				logPath,
				timeoutMs,
				elapsedMs: 0,
			},
			error as Error,
		);
	}
	await writeLedger(options.storeDir, {
		worktree,
		envHash: options.envHash,
		hook: hook.name,
		exitStatus: exit.exitStatus,
		signal: exit.signal,
		ranAt: new Date().toISOString(),
		logPath,
	});
	if (!exit.timedOut && exit.exitStatus === 0) return { status: "ran", hook: hook.name, logPath };
	throw new ResumeSetupHookError(exit.timedOut ? "setup-hook-timed-out" : "setup-hook-failed", {
		hook: hook.name,
		worktree,
		envHash: options.envHash,
		exitStatus: exit.exitStatus,
		signal: exit.signal,
		logPath,
		timeoutMs,
		elapsedMs: exit.elapsedMs,
	});
}
