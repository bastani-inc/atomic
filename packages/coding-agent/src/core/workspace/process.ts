import { type HostChildProcess, spawnHostProcess } from "../../utils/host-spawn.ts";
import * as shellUtils from "../../utils/shell.ts";
import * as processTreeContainment from "../process-tree-containment.ts";

/** How long a stopped process gets to clean up after itself before its process group is killed. */
export const WORKSPACE_PROCESS_STOP_GRACE_MS = 5_000;
/** How often a stopped run looks again whether the rest of its process group has exited. */
const GROUP_EXIT_POLL_MS = 50;
/** How often a stopped Windows run checks whether its contained Job object has drained. */
const TREE_EXIT_POLL_MS = 5;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
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
	readonly onSpawn?: (pid: number) => void | Promise<void>;
}

export type WorkspaceProcessOutcome =
	| { readonly kind: "exited"; readonly stdout: string; readonly stderr: string; readonly status: number | null }
	| { readonly kind: "not-started"; readonly error: Error & { readonly code?: string } };

function errnoCode(error: unknown): unknown {
	return (error as { readonly code?: unknown }).code;
}

function holdDescendantsStatus(pid: number): processTreeContainment.ProcessDescendantsHold {
	if (processTreeContainment.holdProcessDescendantsResult !== undefined) {
		return processTreeContainment.holdProcessDescendantsResult(pid);
	}
	const held = processTreeContainment.holdProcessDescendants?.(pid);
	return held === undefined ? { kind: "unavailable" } : { kind: "held", held };
}

function treeRunning(tree: processTreeContainment.ProcessTreeContainment | undefined): boolean {
	try {
		return tree !== undefined && tree.activeProcesses() > 0;
	} catch {
		return false;
	}
}

function stopWindowsTree(
	child: HostChildProcess,
	tree: processTreeContainment.ProcessTreeContainment | undefined,
	state: { treeTerminated: boolean },
): void {
	const pid = child.pid;
	const live = pid !== undefined && child.exitCode === null && child.signalCode === null;
	let hold: processTreeContainment.ProcessDescendantsHold = { kind: "unavailable" };
	let holdEnded = false;
	if (live) {
		// End the live root and any descendants started before the Job object attached.
		hold = holdDescendantsStatus(pid);
		holdEnded = hold.kind === "held" && hold.held.endAll();
	}
	// Terminate the Job object at most once: reaches orphan grandchildren whose starter exited, and
	// processes left running after the root exited.
	if (!state.treeTerminated && tree !== undefined) {
		state.treeTerminated = tree.terminate() === true;
	}
	if (state.treeTerminated || holdEnded || !live) return;
	if (hold.kind === "unavailable") {
		if (shellUtils.killChildProcessTree !== undefined) shellUtils.killChildProcessTree(child, false);
		else shellUtils.killProcessTree(pid);
		return;
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

/**
 * Ask a process and the processes it started to stop. On POSIX its group gets SIGTERM, which git catches to remove a
 * half-added worktree; Windows has no such signal, so its tree is ended through its Job object and native handles, and
 * a later bind repairs what is left.
 */
function terminate(
	child: HostChildProcess,
	tree: processTreeContainment.ProcessTreeContainment | undefined,
	state: { treeTerminated: boolean },
): void {
	if (!OWN_PROCESS_GROUP) {
		stopWindowsTree(child, tree, state);
		return;
	}
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch (error) {
		if (errnoCode(error) !== "ESRCH") child.kill("SIGTERM");
	}
}

/** Whether a process of the group `pid` leads still runs on POSIX. */
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
	const startedAt = performance.now();
	return new Promise<WorkspaceProcessOutcome>((resolvePromise, reject) => {
		const child = spawnHostProcess(run.path, run.args, {
			cwd: run.cwd,
			env: run.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: OWN_PROCESS_GROUP,
		});
		const tree =
			!OWN_PROCESS_GROUP && child.pid !== undefined
				? processTreeContainment.containProcessTreeAllowingBreakaway?.(child.pid)
				: undefined;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let escalation: NodeJS.Timeout | undefined;
		let groupPoll: NodeJS.Timeout | undefined;
		let settled = false;
		const stopState = { treeTerminated: false };
		/** Set once the process is being stopped: how the call fails once it has exited, or after the grace. */
		let stopped: (() => void) | undefined;
		// A promise settles once, so a late `close` after an error, abort or timeout changes nothing.
		const settle = (finish: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			clearTimeout(groupPoll);
			run.signal?.removeEventListener("abort", onAbort);
			if (stopped === undefined) tree?.release();
			tree?.close();
			finish();
		};
		/**
		 * A stopped run fails once its process and every process of its group (or Windows Job object) are gone. A helper
		 * that ignores SIGTERM and let go of the output streams keeps the group, so the grace's kill stays armed for it.
		 */
		const settleWhenStopped = (): void => {
			if (settled || stopped === undefined) return;
			if (child.exitCode === null && child.signalCode === null) return;
			clearTimeout(groupPoll);
			const stillRunning = OWN_PROCESS_GROUP
				? child.pid !== undefined && groupRunning(child.pid)
				: treeRunning(tree);
			if (stillRunning) {
				groupPoll = setTimeout(settleWhenStopped, OWN_PROCESS_GROUP ? GROUP_EXIT_POLL_MS : TREE_EXIT_POLL_MS);
			} else {
				settle(stopped);
			}
		};
		const stop = (failure: () => void): void => {
			if (stopped !== undefined) return;
			stopped = failure;
			terminate(child, tree, stopState);
			escalation = setTimeout(() => {
				if (!OWN_PROCESS_GROUP) {
					stopWindowsTree(child, tree, stopState);
				} else if (child.pid !== undefined) {
					if (shellUtils.killChildProcessTree !== undefined) {
						shellUtils.killChildProcessTree(child, child.exitCode !== null || child.signalCode !== null);
					} else {
						shellUtils.killProcessTree(child.pid);
					}
				}
				settle(failure);
			}, WORKSPACE_PROCESS_STOP_GRACE_MS);
			if (child.exitCode !== null || child.signalCode !== null) settleWhenStopped();
		};
		const onAbort = (): void => stop(() => reject(run.signal!.reason));
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (run.timeoutMs !== undefined) {
			const timeoutMs = run.timeoutMs;
			const onTimeout = (): void => {
				const elapsedMs = performance.now() - startedAt;
				const remainingMs = timeoutMs - elapsedMs;
				if (remainingMs > 0) {
					timer = setTimeout(onTimeout, Math.min(Math.ceil(remainingMs), MAX_TIMER_DELAY_MS));
					return;
				}
				stop(() => reject(run.timeoutError!(Math.ceil(elapsedMs))));
			};
			timer = setTimeout(onTimeout, Math.min(Math.ceil(timeoutMs), MAX_TIMER_DELAY_MS));
		}
		run.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			settle(() => {
				if (stopped !== undefined) stopped();
				else resolvePromise({ kind: "not-started", error });
			});
		});
		child.on("exit", () => {
			if (stopped !== undefined) settleWhenStopped();
		});
		let spawning: Promise<void> | undefined;
		const closed = (code: number | null): void => {
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
		};
		child.on("close", (code) => {
			if (spawning === undefined) closed(code);
			else void spawning.then(() => closed(code));
		});
		if (child.pid !== undefined && run.onSpawn !== undefined) {
			try {
				const spawned = run.onSpawn(child.pid);
				if (spawned !== undefined) spawning = spawned.catch((error: unknown) => stop(() => reject(error)));
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
