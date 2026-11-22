import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getBinDir } from "../../config.js";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { createGitEnvironment } from "../../utils/git-env.ts";
import { isGitProvisionError } from "../../utils/git-errors.ts";
import { type HostChildProcess, spawnHostProcess } from "../../utils/host-spawn.ts";
import { pathExists } from "../../utils/path-exists.ts";
import { asyncScope } from "../async-scope.ts";
import { redactUrlCredentials } from "../error-contract.ts";
import { containProcessTree, type ProcessTreeContainment } from "../process-tree-containment.ts";
import {
	GitUnavailableError,
	gitInstallCommand,
	isGitUnavailableError,
	WorkspaceGitError,
	WorkspaceSnapshotError,
} from "./errors.ts";
import { worktreeSnapshotExcludedRoots } from "./excluded-roots.ts";
import { canonicalizeWorktreePathAsync } from "./paths.ts";

/** The Git executable snapshot operations run, with the environment it needs (a provisioned Git may need some). */
export interface GitExecutable {
	readonly path: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
}

export type GitExecutableResolver = (signal?: AbortSignal) => Promise<GitExecutable>;

const provisionedGit: GitExecutableResolver = async (signal) => {
	const { resolveGit } = await import("../../utils/tools-manager.ts");
	return resolveGit({ signal });
};
let resolveExecutable: GitExecutableResolver = provisionedGit;

/** The Git every snapshot command of one scope runs instead of the resolver's, such as one restore's. */
const scopedExecutable = asyncScope<GitExecutable>();

/**
 * Runs `action` with every snapshot Git command it starts on `executable`, which no resolver is asked for; other
 * operations of this process keep theirs. Undefined: `action` runs as it would without this call.
 */
export function withWorktreeSnapshotGit<T>(
	executable: GitExecutable | undefined,
	action: () => Promise<T>,
): Promise<T> {
	return executable === undefined ? action() : scopedExecutable.run(executable, action);
}

/**
 * Why a snapshot cannot be recorded with the Git already on this machine, checked without downloading one: recording
 * only uses an installed or provisioned Git, so a session that never needs Git otherwise starts no download (#4322). Undefined when such a Git exists, or when an injected resolver decides.
 */
export async function installedGitUnavailable(): Promise<GitUnavailableError | undefined> {
	if (resolveExecutable !== provisionedGit) return undefined;
	const { resolveInstalledGit } = await import("../../utils/tools-manager.ts");
	try {
		await resolveInstalledGit();
		return undefined;
	} catch (error) {
		if (isGitUnavailableError(error)) return error;
		if (!isGitProvisionError(error)) throw error;
		// An earlier download in this process failed another way, such as timing out: no Git is installed.
		return new GitUnavailableError(
			{
				code: "not-installed",
				platform: process.platform,
				arch: process.arch,
				installDir: join(getBinDir(), "git"),
				installCommand: gitInstallCommand(process.platform),
			},
			{ cause: error },
		);
	}
}

/**
 * The single place every worktree snapshot Git invocation gets its executable from. Returns the previous resolver so
 * callers can restore it.
 */
export function setWorktreeSnapshotGit(resolver: GitExecutableResolver): GitExecutableResolver {
	const previous = resolveExecutable;
	resolveExecutable = resolver;
	return previous;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
/**
 * Settings that keep snapshot commands from running hooks, daemons, maintenance or signing in the user's repository,
 * and let Git for Windows write paths longer than 260 characters, which a restore under the store's long path can
 * reach for a path that fits in the user's checkout (#4932); other platforms ignore `core.longpaths`.
 */
const BASE_CONFIG = [
	"-c",
	"core.longpaths=true",
	"-c",
	`core.hooksPath=${NULL_DEVICE}`,
	"-c",
	"core.fsmonitor=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
	"-c",
	"commit.gpgSign=false",
];
/** Conversion settings that make materialization and verification independent of the host's Git configuration. */
export const NEUTRAL_CONVERSION_CONFIG: readonly string[] = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.eol=lf",
	"-c",
	"core.safecrlf=false",
];

export interface GitRunOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string | Uint8Array;
	readonly signal?: AbortSignal;
	/** Exit codes that are results rather than failures, such as 1 from `git cat-file -e`. */
	readonly allowExitCodes?: readonly number[];
	/** Prepend {@link NEUTRAL_CONVERSION_CONFIG}. */
	readonly neutral?: boolean;
	/**
	 * Run a command that talks to a remote so it can never wait for a person: on POSIX it starts in a new session, so
	 * ssh and credential helpers have no terminal to prompt on and fail at once, and ssh runs in batch mode with a
	 * bounded connect time unless the user chose their own ssh command (`GIT_SSH_COMMAND`, `GIT_SSH` or
	 * `core.sshCommand`). A prompt is never answered, so the command fails with the usual {@link WorkspaceGitError}.
	 */
	readonly nonInteractive?: boolean;
}

/** How long a non-interactive ssh waits for a connection before giving up, in seconds. */
export const NON_INTERACTIVE_SSH_CONNECT_TIMEOUT_SECONDS = 15;

export interface GitRunResult {
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly exitCode: number;
}

function exitStatusReportsClosedInput(): void {}

export { redactUrlCredentials };

function gitOperation(args: readonly string[]): string {
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-c") index++;
		else if (!args[index]!.startsWith("-")) return args[index]!;
	}
	return "";
}

function firstLine(text: string): string {
	return redactUrlCredentials(text.trim().split("\n", 1)[0] ?? "").slice(0, 300);
}

/** Whether the user's Git configuration (not the environment) names the ssh command Git runs. */
async function configuresSshCommand(options: GitRunOptions): Promise<boolean> {
	const lookup = await runGit(["config", "--get", "core.sshCommand"], {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		allowExitCodes: [1],
	});
	return lookup.exitCode === 0;
}

/** Kills `child`, and with it the ssh or helper processes it started when it leads its own session. */
/** How long an aborted Git command is waited for after it was killed, before its abort is reported anyway. */
const ABORTED_GIT_EXIT_WAIT_MS = 10_000;
const PROCESS_TREE_POLL_MS = 5;

function killChild(child: HostChildProcess, detached: boolean): void {
	if (detached && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The group is already gone, or cannot be signalled: the child itself is all that is left to kill.
			child.kill("SIGKILL");
		}
		return;
	}
	child.kill("SIGKILL");
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function treeRunning(tree: ProcessTreeContainment | undefined): boolean {
	try {
		return tree !== undefined && tree.activeProcesses() > 0;
	} catch {
		return false;
	}
}

function taskkillTree(pid: number, deadline: number): Promise<number[]> {
	return new Promise((resolve) => {
		let output = "";
		let taskkill: ChildProcess;
		const systemRoot = process.env.SystemRoot || "C:\\Windows";
		try {
			// In the system directory: a kill never keeps the folder Atomic runs in in use.
			taskkill = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
				cwd: systemRoot,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
				env: createChildProcessEnvironment(),
			});
		} catch {
			resolve([]);
			return;
		}
		const done = () => {
			clearTimeout(bound);
			const killed = output.split(/\r?\n/).map((line) => Number(/\d+/.exec(line)?.[0]));
			resolve(killed.filter((id) => Number.isInteger(id) && id !== process.pid));
		};
		const bound = setTimeout(done, Math.max(0, deadline - Date.now()));
		taskkill.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		taskkill.once("close", done);
		taskkill.once("error", done);
	});
}

async function stopCommand(
	child: HostChildProcess,
	detached: boolean,
	tree: ProcessTreeContainment | undefined,
): Promise<void> {
	const deadline = Date.now() + ABORTED_GIT_EXIT_WAIT_MS;
	let closed = false;
	const close = () => {
		closed = true;
	};
	child.once("close", close);
	child.once("error", close);
	let killed: number[] = [];
	if (tree?.terminate() !== true) {
		if (process.platform === "win32" && child.pid !== undefined) killed = await taskkillTree(child.pid, deadline);
		else killChild(child, detached);
	}
	while (Date.now() < deadline && !(closed && !treeRunning(tree) && !killed.some(running))) {
		await sleep(PROCESS_TREE_POLL_MS);
	}
	tree?.close();
}

async function endTree(tree: ProcessTreeContainment | undefined): Promise<void> {
	if (treeRunning(tree) && tree?.terminate()) {
		const deadline = Date.now() + ABORTED_GIT_EXIT_WAIT_MS;
		while (Date.now() < deadline && treeRunning(tree)) await sleep(PROCESS_TREE_POLL_MS);
	}
	tree?.close();
}

/**
 * The `unreadable-path` error for a working directory the process cannot list or enter. Spawning in one fails with the
 * same `ENOENT` or `EACCES` as a missing or non-executable Git, so only the directory itself tells them apart.
 */
async function unreadableDirectory(directory: string): Promise<WorkspaceSnapshotError | undefined> {
	try {
		await access(directory, constants.R_OK | constants.X_OK);
		return undefined;
	} catch (error) {
		return new WorkspaceSnapshotError("unreadable-path", directory, error as Error);
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** The `not-a-repository` refusal for a working directory in a root excluded from snapshots, if it is in one. */
async function excludedDirectory(cwd: string): Promise<WorkspaceSnapshotError | undefined> {
	const roots = worktreeSnapshotExcludedRoots();
	if (roots.length === 0) return undefined;
	const directory = await canonicalizeWorktreePathAsync(cwd);
	for (const root of roots) {
		const path = relative(await canonicalizeWorktreePathAsync(root), directory);
		if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
			return new WorkspaceSnapshotError("not-a-repository", cwd);
		}
	}
	return undefined;
}

function environmentOf(executable: GitExecutable): NodeJS.ProcessEnv {
	return createGitEnvironment(
		{ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GCM_INTERACTIVE: "never" },
		createChildProcessEnvironment(executable.env),
	);
}

/** The environment Git runs in through {@link runGit}, before a command's own variables. */
export async function gitEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
	return environmentOf(scopedExecutable.getStore() ?? (await resolveExecutable(signal)));
}

/**
 * Runs one Git command through the injected executable. Rejects with the signal's reason when aborted, and with
 * `not-a-repository` before resolving Git when the working directory lies in a root excluded from snapshots.
 */
export async function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
	options.signal?.throwIfAborted();
	const excluded = await excludedDirectory(options.cwd);
	if (excluded !== undefined) throw excluded;
	const executable = scopedExecutable.getStore() ?? (await resolveExecutable(options.signal));
	options.signal?.throwIfAborted();
	const env = environmentOf(executable);
	Object.assign(env, options.env);
	if (options.nonInteractive && !env.GIT_SSH_COMMAND && !env.GIT_SSH && !(await configuresSshCommand(options))) {
		env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o ConnectTimeout=${NON_INTERACTIVE_SSH_CONNECT_TIMEOUT_SECONDS}`;
	}
	// A new session has no controlling terminal. Windows has no such thing, and `detached` there opens a console.
	const detached = options.nonInteractive === true && process.platform !== "win32";
	const argv = [...BASE_CONFIG, ...(options.neutral ? NEUTRAL_CONVERSION_CONFIG : []), ...args];
	const spawnFailure = async (error: NodeJS.ErrnoException): Promise<Error> =>
		(error.code === "ENOENT" || error.code === "EACCES") && (await isDirectory(options.cwd))
			? ((await unreadableDirectory(options.cwd)) ??
				new GitUnavailableError(
					{
						code: "not-installed",
						platform: process.platform,
						arch: process.arch,
						installDir: join(getBinDir(), "git"),
						installCommand: gitInstallCommand(process.platform),
						systemGit: { path: executable.path, problem: "probe-failed" },
					},
					{ cause: error },
				))
			: new WorkspaceGitError(
					{
						operation: gitOperation(args),
						cwd: options.cwd,
						exitCode: null,
						detail: (await pathExists(options.cwd))
							? firstLine(error.message)
							: "the working directory does not exist",
					},
					error,
				);
	return new Promise<GitRunResult>((resolve, reject) => {
		let child: HostChildProcess;
		try {
			// Without fork where that costs the host time in proportion to its memory (#5345).
			child = spawnHostProcess(executable.path, argv, { cwd: options.cwd, env, stdio: "pipe", detached });
		} catch (error) {
			// Node throws instead of emitting `error` for some failures, such as a path component that is a file.
			void spawnFailure(error as NodeJS.ErrnoException).then(reject, reject);
			return;
		}
		const tree = child.pid === undefined ? undefined : containProcessTree(child.pid);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			// Rejects once the process has ended, so nothing it started still works in its directories.
			void stopCommand(child, detached, tree).then(() => reject(options.signal?.reason));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (action: () => void) => {
			options.signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			settled = true;
			action();
		};
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish(() => {
				tree?.close();
				void spawnFailure(error).then(reject, reject);
			}),
		);
		child.stdin?.on("error", exitStatusReportsClosedInput);
		child.on("close", (code) =>
			finish(() => {
				const result = {
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: code ?? -1,
				};
				void endTree(tree).then(() => {
					if (code === 0 || (code !== null && options.allowExitCodes?.includes(code))) resolve(result);
					else
						reject(
							new WorkspaceGitError({
								operation: gitOperation(args),
								cwd: options.cwd,
								exitCode: code,
								detail: firstLine(result.stderr),
							}),
						);
				});
			}),
		);
		child.stdin?.end(options.input === undefined ? undefined : options.input);
	});
}

/** Runs a Git command and returns its standard output as UTF-8 text without the trailing newline. */
export async function gitText(args: readonly string[], options: GitRunOptions): Promise<string> {
	const { stdout } = await runGit(args, options);
	return stdout.toString("utf8").replace(/\n$/, "");
}

/** Splits NUL-terminated Git output. */
export function nulFields(output: Buffer | string): string[] {
	const text = typeof output === "string" ? output : output.toString("utf8");
	const fields = text.split("\0");
	if (fields.at(-1) === "") fields.pop();
	return fields;
}
