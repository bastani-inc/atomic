import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
	 * Whether the process waits for one line on its stdin before it does anything, as a bash script that starts with
	 * {@link BASH_START_GATE} does (#4748). It gets that line, ahead of `stdin`, only once {@link stepProcessWatcher} has
	 * recorded it, so a host that dies before recording it leaves nothing of it running.
	 */
	readonly gated?: boolean;
}

/**
 * The start of a bash script whose process is {@link LoggedProcess.gated} (#4748): the shell waits for the line its
 * host sends once it has recorded the process, and ends at once, having run nothing, when the host died first. The
 * script then runs with the null device as its stdin, as an ungated process does.
 */
export const BASH_START_GATE = "read -r _ || exit 1\nexec </dev/null\n";

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
	return new Promise<ProcessExit>((resolveExit, reject) => {
		const child = spawn(run.command, [...run.args], {
			cwd: run.cwd,
			env: run.env,
			detached: startsProcessGroup(process.platform),
			windowsHide: true,
			stdio: [
				run.stdin === undefined && run.gated !== true ? "ignore" : "pipe",
				copiesOutput ? "pipe" : log.fd,
				copiesOutput ? "pipe" : log.fd,
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
		// Only now, after the watcher above recorded the process: a gated process starts its work on this line (#4748). A
		// process that ended before reading it, as one stopped at once, never needs it, so failing to write it is no error.
		if (run.stdin !== undefined || run.gated === true) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(`${run.gated === true ? "\n" : ""}${run.stdin ?? ""}`);
		}
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
