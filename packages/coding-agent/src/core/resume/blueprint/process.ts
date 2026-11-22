import { type ChildProcess, spawn } from "node:child_process";
import { write } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { waitForChildProcess } from "../../../utils/child-process.ts";
import { killChildProcessTree } from "../../../utils/shell.ts";
import { asyncScope } from "../../async-scope.ts";
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
export const stepProcessWatcher = asyncScope<(pid: number, running: boolean, stillRunning?: () => boolean) => void>();

export const stepStartingWatcher = asyncScope<() => void>();

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
 * How many times, how far apart, and for how long a process the system refuses to start for a moment is tried. The first
 * tries are 50 ms apart for half a second. A busy Windows machine has refused a start for most of a second (#6124), so
 * the tries go on, each after half the time already spent (100 to 400 ms), until two seconds after the first: a
 * program that stays refused fails its step at most that much later. A refused process was never created, so trying
 * again cannot run a step twice.
 */
const SPAWN_STEADY_TRIES = 10;
const SPAWN_RETRY_MS = 50;
const SPAWN_STEADY_WINDOW_MS = 500;
const SPAWN_BACKOFF_MIN_MS = 100;
const SPAWN_BACKOFF_MAX_MS = 400;
const SPAWN_RETRY_WINDOW_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The refusals that pass once another program lets go of the file, as an antivirus scan or the installer that just wrote
 * it does. Windows refuses with EPERM while no one may execute the file and with EBUSY while a program holds it open for
 * writing; Linux refuses with ETXTBSY while a program holds it open for writing.
 */
function passingRefusals(platform: NodeJS.Platform): readonly string[] {
	return platform === "win32" ? ["EPERM", "EBUSY"] : ["ETXTBSY"];
}

/** Measures whole milliseconds, counting suspend without letting a backward wall-clock change extend a deadline. */
export function startElapsedMs(wallStart = Date.now()): () => number {
	const monoStart = performance.now();
	return () => {
		// Keep the monotonic interval inside the wall interval, even if descheduled between reads.
		const activeMs = Math.floor(performance.now() - monoStart);
		return Math.max(Date.now() - wallStart, activeMs);
	};
}

/**
 * How long a start refused with `error` on try `tries`, `elapsedMs` into a step allowed `timeoutMs`, waits before it is
 * tried again; undefined when it is not tried again. A try is made only while the shortest wait still ends inside the
 * window and before the step's timeout, and no wait ends after either.
 */
function retryWaitMs(error: unknown, tries: number, elapsedMs: number, timeoutMs: number): number | undefined {
	if (!passingRefusals(process.platform).includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
	const lastStartMs = Math.min(SPAWN_RETRY_WINDOW_MS, Math.ceil(timeoutMs) - 1);
	// Written so that a timeout that is not a number, which no try fits, makes none.
	if (!(elapsedMs + SPAWN_RETRY_MS <= lastStartMs)) return undefined;
	if (tries < SPAWN_STEADY_TRIES && elapsedMs + SPAWN_RETRY_MS <= SPAWN_STEADY_WINDOW_MS) return SPAWN_RETRY_MS;
	const backoffMs = Math.min(SPAWN_BACKOFF_MAX_MS, Math.max(SPAWN_BACKOFF_MIN_MS, Math.floor(elapsedMs / 2)));
	return Math.min(backoffMs, lastStartMs - elapsedMs);
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
 * (`spawnError`), including when the system refuses to start it at once. A refusal that passes by itself (EPERM or
 * EBUSY on Windows, ETXTBSY on Linux) is tried again for up to two seconds first, and nothing starts once `timeoutMs`
 * has passed. Rejects with `signal.reason` when `options.signal` aborts, since cancelling is not a failure; nothing
 * starts once it has.
 */
export async function runLoggedProcess(
	run: LoggedProcess,
	log: StepLog,
	options: LoggedProcessOptions,
): Promise<ProcessExit> {
	options.signal?.throwIfAborted();
	const elapsedMs = startElapsedMs();
	const copiesOutput = copiesOutputToLog(process.platform);
	let started: ChildProcess;
	// How long the step waited to try again before its process started: that time counts toward its timeout.
	let waitedMs = 0;
	let refusal: Error | undefined;
	for (let tries = 1; ; tries++) {
		buildProcessStarting();
		// Also cancelled while it waited to try again, or by what ran in between: then nothing may start.
		options.signal?.throwIfAborted();
		if (refusal !== undefined) {
			waitedMs = elapsedMs();
			// A try that wakes late, as when the event loop was busy, starts nothing once the step's time is up.
			if (waitedMs >= Math.ceil(options.timeoutMs)) {
				return {
					exitStatus: null,
					signal: null,
					timedOut: false,
					elapsedMs: waitedMs,
					spawnError: refusal,
				};
			}
		}
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
			// spawn throws, rather than emitting "error", when the system refuses at once (EPERM, EBUSY, ETXTBSY, ENOTDIR).
			const elapsed = elapsedMs();
			refusal = error as Error;
			const waitMs = retryWaitMs(error, tries, elapsed, options.timeoutMs);
			if (waitMs === undefined) {
				return {
					exitStatus: null,
					signal: null,
					timedOut: false,
					elapsedMs: elapsed,
					spawnError: refusal,
				};
			}
			await pause(waitMs, options.signal);
		}
	}
	const child = started;
	return new Promise<ProcessExit>((resolveExit, reject) => {
		const tree = child.pid === undefined ? undefined : containProcessTree(child.pid);
		const watch = stepProcessWatcher.getStore();
		if (child.pid !== undefined) {
			watch?.(child.pid, true, () => child.exitCode === null && child.signalCode === null);
		}
		let timedOut = false;
		let stopped = false;
		let treeTerminated = false;
		let warnedAboutDescendants = false;
		let writeError: Error | undefined;
		let copying = Promise.resolve();
		const stop = () => {
			stopped = true;
			// Terminating the tree ends every process in it, and closing it ends any left: it is terminated at most once.
			if (!treeTerminated) treeTerminated = tree?.terminate() === true;
			// A failed spawn can have an exit code even though no process was created.
			if (treeTerminated || child.pid === undefined) return;
			// Once the command's exit is reported, its pid may name another process: nothing is killed by that pid.
			const exited = child.exitCode !== null || child.signalCode !== null;
			if (process.platform === "win32" && tree === undefined && exited && !warnedAboutDescendants) {
				warnedAboutDescendants = true;
				process.emitWarning(
					"The blueprint command exited without a Windows Job object; its descendants may still be running.",
				);
			}
			killChildProcessTree(child, exited);
		};
		const { timeoutMs } = options;
		const remainingMs = Math.max(0, timeoutMs - waitedMs);
		// Clamp finite budgets to the timer range, but let the runtime diagnose an invalid timeout itself.
		const delayMs = Number.isFinite(timeoutMs)
			? Math.max(1, Math.min(MAX_TIMER_MS, Math.floor(remainingMs)))
			: remainingMs;
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, delayMs);
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
				elapsedMs: elapsedMs(),
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
			resolveExit({ exitStatus, signal: exitSignal, timedOut, elapsedMs: elapsedMs() });
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
