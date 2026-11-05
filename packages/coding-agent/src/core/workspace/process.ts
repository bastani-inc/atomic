import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree } from "../../utils/shell.ts";

/** How long a stopped process gets to clean up after itself before its process group is killed. */
export const WORKSPACE_PROCESS_STOP_GRACE_MS = 5_000;
/** How often a stopped run looks again whether the rest of its process group has exited. */
const GROUP_EXIT_POLL_MS = 50;
/** On POSIX each process runs in its own process group, so stopping it also stops what it started. */
const OWN_PROCESS_GROUP = process.platform !== "win32";

export interface WorkspaceProcessRun {
	readonly path: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	/** The failure of a run that exceeded `timeoutMs`, given how long it ran. Required with `timeoutMs`. */
	readonly timeoutError?: (elapsedMs: number) => Error;
	/** Called once the process started, with its pid. A throw stops the process and becomes the run's failure. */
	readonly onSpawn?: (pid: number) => void;
}

export type WorkspaceProcessOutcome =
	| { readonly kind: "exited"; readonly stdout: string; readonly stderr: string; readonly status: number | null }
	| { readonly kind: "not-started"; readonly error: Error & { readonly code?: string } };

function errnoCode(error: unknown): unknown {
	return (error as { readonly code?: unknown }).code;
}

/**
 * Ask a process and the processes it started to stop. On POSIX its group gets SIGTERM, which git catches to remove a
 * half-added worktree; Windows has no such signal, so the tree is killed and a later bind repairs what is left.
 */
function terminate(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (!OWN_PROCESS_GROUP) {
		killProcessTree(child.pid);
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch (error) {
		if (errnoCode(error) !== "ESRCH") child.kill("SIGTERM");
	}
}

/** Whether a process of the group `pid` leads still runs. Windows has no process groups; its tree is killed at once. */
function groupRunning(pid: number): boolean {
	if (!OWN_PROCESS_GROUP) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) === "EPERM";
	}
}

/**
 * Run a process to its end. Cancellation and timeouts stop it with everything it started and wait for it to exit, or
 * kill its group after a grace, before the call fails, so nothing it started outlives the call; cancellation rejects
 * with `signal.reason`. A process that could not be started resolves as `not-started`.
 */
export function runWorkspaceProcess(run: WorkspaceProcessRun): Promise<WorkspaceProcessOutcome> {
	const startedAt = Date.now();
	return new Promise<WorkspaceProcessOutcome>((resolvePromise, reject) => {
		const child = spawn(run.path, run.args, {
			cwd: run.cwd,
			env: run.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: OWN_PROCESS_GROUP,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let escalation: NodeJS.Timeout | undefined;
		let groupPoll: NodeJS.Timeout | undefined;
		/** Set once the process is being stopped: how the call fails once it has exited, or after the grace. */
		let stopped: (() => void) | undefined;
		// A promise settles once, so a late `close` after an error, abort or timeout changes nothing.
		const settle = (finish: () => void): void => {
			clearTimeout(timer);
			clearTimeout(escalation);
			clearTimeout(groupPoll);
			run.signal?.removeEventListener("abort", onAbort);
			finish();
		};
		const stop = (failure: () => void): void => {
			if (stopped !== undefined) return;
			stopped = failure;
			terminate(child);
			escalation = setTimeout(() => {
				killProcessTree(child.pid!);
				settle(failure);
			}, WORKSPACE_PROCESS_STOP_GRACE_MS);
		};
		const onAbort = (): void => stop(() => reject(run.signal!.reason));
		const timer =
			run.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						const elapsedMs = Date.now() - startedAt;
						stop(() => reject(run.timeoutError!(elapsedMs)));
					}, run.timeoutMs);
		run.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			settle(() => {
				if (stopped !== undefined) stopped();
				else resolvePromise({ kind: "not-started", error });
			});
		});
		/**
		 * A stopped run fails once its process and every process of its group are gone. A helper that ignores SIGTERM and
		 * let go of the output streams keeps the group, so the grace's group kill stays armed for it.
		 */
		const settleWhenStopped = (): void => {
			if (child.exitCode === null && child.signalCode === null) return;
			clearTimeout(groupPoll);
			if (groupRunning(child.pid!)) groupPoll = setTimeout(settleWhenStopped, GROUP_EXIT_POLL_MS);
			else settle(stopped!);
		};
		child.on("exit", () => {
			if (stopped !== undefined) settleWhenStopped();
		});
		child.on("close", (code) => {
			if (stopped !== undefined) {
				settleWhenStopped();
				return;
			}
			settle(() =>
				resolvePromise({
					kind: "exited",
					stdout: Buffer.concat(stdout).toString("utf-8"),
					stderr: Buffer.concat(stderr).toString("utf-8"),
					status: code,
				}),
			);
		});
		if (child.pid !== undefined && run.onSpawn !== undefined) {
			try {
				run.onSpawn(child.pid);
			} catch (error) {
				stop(() => reject(error));
			}
		}
	});
}

/** Shared work keeps running for other waiters; each waiter stops waiting when its own signal aborts. */
export function waitFor<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return shared;
	signal.throwIfAborted();
	return new Promise<T>((resolvePromise, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		shared.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
