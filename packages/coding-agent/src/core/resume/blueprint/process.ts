import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { waitForChildProcess } from "../../../utils/child-process.ts";
import { killProcessTree } from "../../../utils/shell.ts";
import { containProcessTree, type ProcessTreeContainment, processTreeEnded } from "../../process-tree-containment.ts";

/** A step's log file, open for appending: the child processes of the step write their output to `fd`. */
export interface StepLog {
	readonly fd: number;
	readonly path: string;
}

/** One process a step starts. */
export interface LoggedProcess {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Written to the process's stdin, for shells that take the command that way; otherwise stdin is closed. */
	readonly stdin?: string;
	/**
	 * Whether the process starts only once {@link stepProcessWatcher} has recorded it (#4748), so a host that dies before
	 * recording it leaves nothing of it running: not even code its environment would run first, such as a shell's
	 * `BASH_ENV` and exported functions or the modules `NODE_OPTIONS` preloads. Where {@link gatesSteps} says so, it is
	 * started by {@link START_GATE_SHELL} with an empty environment, which waits for one line on file descriptor
	 * {@link START_GATE_FD} and then becomes the process through {@link START_GATE_ENV}, so it keeps its id, arguments
	 * and environment. Elsewhere it starts at once.
	 */
	readonly gated?: boolean;
}

/** The shell that holds a gated process until its host has recorded it (#4748). */
export const START_GATE_SHELL = "/bin/sh";

/** What gives a gated process its environment back once it may start (#4748), `env -i` with every variable. */
export const START_GATE_ENV = "/usr/bin/env";

/**
 * The file descriptor a gated process's start line comes on (#4748): not stdin, which stays as it was, since bash runs
 * `~/.bashrc` instead of `BASH_ENV` when its stdin is a socket, as a pipe from Node.js or Bun is.
 */
export const START_GATE_FD = 3;

/**
 * What {@link START_GATE_SHELL} runs, with the command line to become as `$@`: it waits for the line, ends at once,
 * having run nothing, when its host died first, closes the descriptor so nothing the process starts inherits it, and
 * becomes the process.
 */
const START_GATE_SCRIPT = `IFS= read -r _ <&${START_GATE_FD} || exit 1; exec ${START_GATE_FD}<&-; exec "$@"`;

/**
 * Whether steps on `platform` are gated (#4748). On Windows they are not: Atomic puts each step's process in a job
 * object right after starting it, which ends it when Atomic ends, and Git Bash takes no file descriptor past stderr
 * from its host.
 */
export function gatesSteps(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}

/**
 * How `run` is spawned so that it starts only once released (#4748): {@link START_GATE_SHELL} with no environment at
 * all, so nothing in it runs before the gate, which then runs `env -i` with each of `run`'s variables and the command.
 * Undefined where it cannot be: off the platforms {@link gatesSteps} names, without the shell or `env`, or for a command
 * `env` would take for a variable; a variable `env` could take for an option is left out.
 */
function startGated(run: LoggedProcess): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
	if (!gatesSteps(process.platform) || run.command.includes("=")) return undefined;
	if (!existsSync(START_GATE_SHELL) || !existsSync(START_GATE_ENV)) return undefined;
	const variables = Object.entries(run.env).flatMap(([name, value]) =>
		value === undefined || name === "" || name.startsWith("-") ? [] : [`${name}=${value}`],
	);
	const line = [START_GATE_ENV, "-i", ...variables, run.command, ...run.args];
	return { command: START_GATE_SHELL, args: ["-c", START_GATE_SCRIPT, "start-gate", ...line], env: {} };
}

export interface ProcessExit {
	readonly exitStatus: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly elapsedMs: number;
	/** Why the process could not be started, when it could not. */
	readonly spawnError?: Error;
}

export interface LoggedProcessOptions {
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

/**
 * Told of each process a step starts (`running` true) and of its end, for the build that runs the step: a build records
 * them so a later process can stop them when this one dies without stopping them (#4748).
 */
export const stepProcessWatcher = new AsyncLocalStorage<(pid: number, running: boolean) => void>();

const STOPPED_PROCESS_TREE_WAIT_MS = 10_000;

async function settleTree(tree: ProcessTreeContainment | undefined, stopped: boolean): Promise<void> {
	if (tree === undefined) return;
	if (!stopped) {
		tree.release();
		return;
	}
	await processTreeEnded(tree, STOPPED_PROCESS_TREE_WAIT_MS);
	tree.close();
}

/** Whether a process started on `platform` leads its own process group, which is how stopping it stops its children. */
export function startsProcessGroup(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}

export function copiesOutputToLog(platform: NodeJS.Platform): boolean {
	return platform === "win32";
}

/**
 * Runs `run` with its output appended to `log`, in its own process group (POSIX) so stopping it stops everything it
 * started. Resolves how it ended: exited, stopped by a signal, timed out after `timeoutMs`, or could not be started
 * (`spawnError`). Rejects with `signal.reason` when `options.signal` aborts, since cancelling is not a failure.
 */
export async function runLoggedProcess(
	run: LoggedProcess,
	log: StepLog,
	options: LoggedProcessOptions,
): Promise<ProcessExit> {
	options.signal?.throwIfAborted();
	const startedAt = Date.now();
	const copiesOutput = copiesOutputToLog(process.platform);
	const gated = run.gated === true ? startGated(run) : undefined;
	return new Promise<ProcessExit>((resolveExit, reject) => {
		const child = spawn(gated?.command ?? run.command, gated?.args ?? [...run.args], {
			cwd: run.cwd,
			env: gated?.env ?? run.env,
			detached: startsProcessGroup(process.platform),
			windowsHide: true,
			stdio: [
				run.stdin === undefined ? "ignore" : "pipe",
				copiesOutput ? "pipe" : log.fd,
				copiesOutput ? "pipe" : log.fd,
				...(gated === undefined ? [] : ["pipe" as const]),
			],
		});
		const tree = child.pid === undefined ? undefined : containProcessTree(child.pid);
		const watch = stepProcessWatcher.getStore();
		if (child.pid !== undefined) watch?.(child.pid, true);
		let timedOut = false;
		let stopped = false;
		let writeError: Error | undefined;
		const stop = () => {
			stopped = true;
			if (tree?.terminate()) return;
			if (child.pid !== undefined) killProcessTree(child.pid);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs);
		const onAbort = () => stop();
		if (copiesOutput) {
			const fail = (what: string, error: Error) => {
				if (writeError !== undefined) return;
				writeError = new Error(`The output of ${run.command} could not be ${what} the log ${log.path}`, {
					cause: error,
				});
				stop();
			};
			const copy = (chunk: Buffer) => {
				if (writeError !== undefined) return;
				try {
					writeFully(log.fd, chunk);
				} catch (error) {
					fail("written to", error as Error);
				}
			};
			for (const stream of [child.stdout, child.stderr]) {
				stream?.on("data", copy);
				stream?.on("error", (error) => {
					if (!timedOut && !options.signal?.aborted) fail("read for", error);
				});
			}
		}
		const settle = () => {
			if (child.pid !== undefined) watch?.(child.pid, false);
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		options.signal?.addEventListener("abort", onAbort);
		const onSpawnError = (error: Error) => {
			settle();
			tree?.close();
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			resolveExit({
				exitStatus: null,
				signal: null,
				timedOut: false,
				elapsedMs: Date.now() - startedAt,
				spawnError: error,
			});
		};
		const ended = async (exitStatus: number | null, exitSignal: NodeJS.Signals | null) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			await settleTree(tree, stopped);
			settle();
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			if (writeError !== undefined) {
				reject(writeError);
				return;
			}
			resolveExit({ exitStatus, signal: exitSignal, timedOut, elapsedMs: Date.now() - startedAt });
		};
		if (copiesOutput) {
			waitForChildProcess(child).then((exitStatus) => ended(exitStatus, child.signalCode), onSpawnError);
		} else {
			child.once("error", onSpawnError);
			child.once("close", ended);
		}
		if (run.stdin !== undefined) child.stdin?.end(run.stdin);
		// Only now, after the watcher above recorded the process: a gated process starts its work on this line (#4748). A
		// process that ended before reading it, as one stopped at once, never needs it, so failing to write it is no error.
		const release = gated === undefined ? undefined : (child.stdio[START_GATE_FD] as Writable | null | undefined);
		release?.on("error", () => {});
		release?.end("\n");
	});
}

function writeFully(fd: number, chunk: Buffer): void {
	let written = 0;
	while (written < chunk.length) {
		const count = writeSync(fd, chunk, written);
		if (count <= 0) throw new Error("the log accepted no bytes");
		written += count;
	}
}

/** Opens `path` for appending with owner-only permissions; the caller closes it. */
export async function openStepLog(path: string): Promise<StepLog & { close(): Promise<void> }> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "a", 0o600);
	return { fd: handle.fd, path, close: () => handle.close() };
}

/** How much of a log's end a build outcome keeps. */
export const LOG_TAIL_BYTES = 4096;

/** The last `bytes` of the file at `path`, or an empty string when it cannot be read. */
export async function logTail(path: string, bytes: number = LOG_TAIL_BYTES): Promise<string> {
	try {
		const content = await readFile(path);
		return content.subarray(Math.max(0, content.length - bytes)).toString("utf8");
	} catch {
		return "";
	}
}
