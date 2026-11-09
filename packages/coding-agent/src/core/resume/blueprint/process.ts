import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { killProcessTree } from "../../../utils/shell.ts";

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

/** Whether a process started on `platform` leads its own process group, which is how stopping it stops its children. */
export function startsProcessGroup(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
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
	return new Promise<ProcessExit>((resolveExit, reject) => {
		const child = spawn(run.command, [...run.args], {
			cwd: run.cwd,
			env: run.env,
			detached: startsProcessGroup(process.platform),
			windowsHide: true,
			stdio: [run.stdin === undefined ? "ignore" : "pipe", log.fd, log.fd],
		});
		let timedOut = false;
		const stop = () => {
			if (child.pid !== undefined) killProcessTree(child.pid);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs);
		const onAbort = () => stop();
		const settle = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		options.signal?.addEventListener("abort", onAbort);
		child.once("error", (error) => {
			settle();
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
		});
		child.once("close", (exitStatus, exitSignal) => {
			settle();
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			resolveExit({ exitStatus, signal: exitSignal, timedOut, elapsedMs: Date.now() - startedAt });
		});
		if (run.stdin !== undefined) child.stdin?.end(run.stdin);
	});
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
