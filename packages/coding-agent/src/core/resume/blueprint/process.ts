import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { write } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
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

export const stepStartingWatcher = new AsyncLocalStorage<() => void>();

export function buildProcessStarting(): void {
	stepStartingWatcher.getStore()?.();
}

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
 * How many times, and how far apart, a process Windows refuses to start for a moment is tried: about two seconds in
 * all. Windows refuses with EPERM while no one may execute the file and with EBUSY while another program holds it open
 * for writing, as an antivirus scan or the installer that just wrote it can. A refused process was never created, so
 * trying again cannot run a step twice.
 */
const SPAWN_TRIES = 40;
const SPAWN_RETRY_MS = 50;
const PASSING_SPAWN_REFUSALS: ReadonlySet<string> = new Set(["EPERM", "EBUSY"]);

/** Whether a start refused with `error` on try `tries`, `elapsedMs` into a step allowed `timeoutMs`, is tried again. */
function triesStartAgain(error: unknown, tries: number, elapsedMs: number, timeoutMs: number): boolean {
	return (
		process.platform === "win32" &&
		PASSING_SPAWN_REFUSALS.has((error as NodeJS.ErrnoException).code ?? "") &&
		tries < SPAWN_TRIES &&
		elapsedMs + SPAWN_RETRY_MS < timeoutMs
	);
}

/** Waits `ms`, or rejects with the reason of `signal` as soon as it aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Runs `run` with its output appended to `log`, in its own process group (POSIX) so stopping it stops everything it
 * started. Resolves how it ended: exited, stopped by a signal, timed out after `timeoutMs`, or could not be started
 * (`spawnError`), including when the system refuses to start it at once. On Windows a refusal that passes by itself
 * (EPERM, EBUSY) is tried again for about two seconds first, within `timeoutMs`. Rejects with `signal.reason` when
 * `options.signal` aborts, since cancelling is not a failure.
 */
export async function runLoggedProcess(
	run: LoggedProcess,
	log: StepLog,
	options: LoggedProcessOptions,
): Promise<ProcessExit> {
	options.signal?.throwIfAborted();
	const startedAt = Date.now();
	const copiesOutput = copiesOutputToLog(process.platform);
	let started: ChildProcess;
	for (let tries = 1; ; tries++) {
		buildProcessStarting();
		try {
			started = spawn(run.command, [...run.args], {
				cwd: run.cwd,
				env: run.env,
				detached: startsProcessGroup(process.platform),
				windowsHide: true,
				stdio: [
					run.stdin === undefined ? "ignore" : "pipe",
					copiesOutput ? "pipe" : log.fd,
					copiesOutput ? "pipe" : log.fd,
				],
			});
			break;
		} catch (error) {
			// spawn throws, rather than emitting "error", when the system refuses at once (EPERM, EBUSY, ENOTDIR): nothing started.
			const elapsedMs = Date.now() - startedAt;
			if (!triesStartAgain(error, tries, elapsedMs, options.timeoutMs)) {
				return { exitStatus: null, signal: null, timedOut: false, elapsedMs, spawnError: error as Error };
			}
			await pause(SPAWN_RETRY_MS, options.signal);
		}
	}
	const child = started;
	return new Promise<ProcessExit>((resolveExit, reject) => {
		const tree = child.pid === undefined ? undefined : containProcessTree(child.pid);
		const watch = stepProcessWatcher.getStore();
		if (child.pid !== undefined) watch?.(child.pid, true);
		let timedOut = false;
		let stopped = false;
		let writeError: Error | undefined;
		let copying = Promise.resolve();
		const stop = () => {
			stopped = true;
			if (tree?.terminate()) return;
			if (child.pid !== undefined) killProcessTree(child.pid);
		};
		const timer = setTimeout(
			() => {
				timedOut = true;
				stop();
			},
			Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
		);
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
				copying = copying.then(async () => {
					if (writeError !== undefined) return;
					try {
						await appendToLog(log, chunk);
					} catch (error) {
						fail("written to", error as Error);
					}
				});
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
			await copying;
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
	});
}

const writeToFd = promisify(write);

export async function appendToLog(log: StepLog, data: string | Buffer): Promise<void> {
	const chunk = typeof data === "string" ? Buffer.from(data) : data;
	let written = 0;
	while (written < chunk.length) {
		const { bytesWritten } = await writeToFd(log.fd, chunk, written, chunk.length - written, null);
		if (bytesWritten <= 0) throw new Error("the log accepted no bytes");
		written += bytesWritten;
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
