/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createChildProcessEnvironment, waitForChildProcess } from "../utils/child-process.ts";
import { type HostChildProcess, spawnHostProcess } from "../utils/host-spawn.ts";
import {
	descendantsOf,
	descendantsOfNow,
	type IdentifiedProcess,
	signalIfSame,
	signalIfSameNow,
} from "./process-descendants.js";
import { containProcessTree } from "./process-tree-containment.ts";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;
/**
 * How long a command its session's quit ends may take to exit after SIGTERM before it gets SIGKILL. Short, so that the
 * session's shutdown handlers still have most of the quit's grace period once every such command has ended.
 */
const QUIT_FORCE_KILL_DELAY_MS = 1000;

/**
 * The commands running now that their session's quit would stop, each until it exits: those started with `onQuit`
 * (see {@link execCommand}).
 */
const quitStoppableCommands = new Set<HostChildProcess>();

/** Whether a command its session's quit would stop is running in this process. */
export function hasQuitStoppableCommands(): boolean {
	return quitStoppableCommands.size > 0;
}

/**
 * Ends at once, with `SIGKILL`, every running command that its session's quit would stop, and the processes it
 * started (as the quit reads them), for a process about to exit that can no longer wait, such as an engine whose host
 * is gone. Each of these is signalled only while it is the process recorded; the command itself through its own
 * handle. Not on Windows, where they end with the process that started them.
 */
export function killQuitStoppableCommandsNow(): void {
	if (process.platform === "win32") return;
	for (const proc of quitStoppableCommands) {
		const pid = proc.pid;
		if (pid === undefined || proc.exitCode !== null || proc.signalCode !== null) continue;
		// Read while the command still runs: once it ends, the processes it started are no longer below it.
		const descendants = descendantsOfNow(pid);
		proc.kill("SIGKILL");
		signalIfSameNow(descendants, "SIGKILL");
	}
	quitStoppableCommands.clear();
}

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/**
	 * Combined stdout/stderr byte limit; exceeding it terminates the command with `truncated: true`.
	 * Nonnegative integer up to the runtime string limit. Default: 256 MiB, capped by that limit.
	 */
	maxBuffer?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	/** Exit code, or 128 + signal number when a signal terminated the command (143 for SIGTERM). */
	code: number;
	/** The command was terminated by pi: timeout, abort, or output over `maxBuffer`. */
	killed: boolean;
	/** Output exceeded `maxBuffer`; stdout and stderr are incomplete and `code` is nonzero. */
	truncated: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout, abort signal, and an output cap (`maxBuffer`).
 *
 * `onQuit` registers a stop to run when the command's session starts to quit, and returns its unregistration. The stop
 * ends a command still running so that it cannot hold the session's shutdown: it and the processes it started get
 * SIGTERM, and those still running after {@link QUIT_FORCE_KILL_DELAY_MS}, or once the command exited, SIGKILL; output
 * its descendants still hold open is then no longer waited for. The processes it started are the ones running when the
 * stop starts (on Windows they end with this process instead). A command that already exited is left as it is. Such a
 * command is also one that {@link killQuitStoppableCommandsNow} ends while it runs.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
	onQuit?: (stop: () => void) => () => void,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}

	// Without fork where that costs the host time in proportion to its memory (#5345).
	const proc = spawnHostProcess(command, args, {
		cwd,
		// Pass the environment explicitly. Bun snapshots the process environment
		// at startup for spawns that omit `env`, so an inherited default would
		// still carry values this process deleted from `process.env` — including
		// the interactive-engine control variables and their --api-key. Preserve
		// Atomic's child attribution in the same explicit environment.
		env: createChildProcessEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
		// A command a quit would stop must not outlive this process when it is killed instead.
		endWithParent: onQuit !== undefined,
	});
	// Until it settles; one that exited by then is left alone (see killQuitStoppableCommandsNow).
	if (onQuit !== undefined && proc.pid !== undefined) quitStoppableCommands.add(proc);
	// On Windows such a command runs in a job of its own, which this process holds: a stop ends its process tree
	// through the job, never through a process ID another process may have taken by then, and the tree ends with this
	// process. A process the command starts in the first microseconds, before the command is in the job, is outside it;
	// one that asks to leave the job, as `CREATE_BREAKAWAY_FROM_JOB` does, still can.
	const job =
		process.platform === "win32" && onQuit !== undefined && proc.pid !== undefined
			? containProcessTree(proc.pid, { allowBreakaway: true })
			: undefined;

	let stdout = "";
	let stderr = "";
	// Decode across chunks: a multi-byte UTF-8 character can be split between two chunks,
	// and decoding each chunk separately would corrupt it (earendil-works/pi#11312).
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let outputBytes = 0;
	let truncated = false;
	let killed = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let forceKillId: NodeJS.Timeout | undefined;
	let quitCutId: NodeJS.Timeout | undefined;
	const exited = () => proc.exitCode !== null || proc.signalCode !== null;

	/** The processes the command had started when it was stopped, read while it still ran. */
	let stoppedDescendants: readonly IdentifiedProcess[] = [];
	/** Whether the command's process tree was ended through its job on Windows, where the command then exits with status 1. */
	let windowsTreeEnded = false;
	let treeStop: Promise<boolean> | undefined;
	/**
	 * Ends the command and the processes it started: on POSIX those below it in its process group, read while it still
	 * runs, get SIGTERM with it; on Windows its process tree ends. Resolves whether it did: a command that ended on its
	 * own first, during the few milliseconds the read or Windows's tree kill takes, leaves the processes it started, as
	 * one that ended before.
	 */
	const endTree = (): Promise<boolean> => {
		treeStop ??= (async () => {
			const pid = proc.pid;
			if (pid === undefined || exited()) return false;
			if (process.platform === "win32") {
				if (job?.terminate()) {
					windowsTreeEnded = true;
					return true;
				}
				// Without its job the command itself ends, through its own handle, as it always did.
				proc.kill("SIGTERM");
				return true;
			}
			// Read before the command is signalled: once it exits, the processes it started are no longer below it.
			const descendants = await descendantsOf(pid);
			if (exited()) return false;
			stoppedDescendants = descendants;
			proc.kill("SIGTERM");
			await signalIfSame(stoppedDescendants, "SIGTERM");
			return true;
		})();
		return treeStop;
	};

	const killProcess = (startedAborted = false) => {
		if (killed) return;
		killed = true;
		// A command started with its abort already signalled has started nothing: it ends at once, as it always did.
		if (startedAborted) proc.kill("SIGTERM");
		else void endTree();
		forceKillId = setTimeout(() => {
			// `proc.killed` only says a signal was sent, so check whether the child actually exited.
			if (!exited()) {
				proc.kill("SIGKILL");
			}
			void signalIfSame(stoppedDescendants, "SIGKILL");
		}, FORCE_KILL_DELAY_MS);
	};

	let quitStop: Promise<void> | undefined;
	const stopForQuit = () => {
		// A command that never started has nothing to end; its start failure settles it. One that already exited keeps
		// its result, and the output its descendants still write is waited for as before.
		if (proc.pid === undefined || exited() || quitStop !== undefined) return;
		quitStop = (async () => {
			if (!(await endTree())) return;
			killProcess();
			// The command has a short window to end; then it gets SIGKILL, also when its caller already stopped it, and
			// output its descendants still hold open is no longer waited for.
			quitCutId = setTimeout(() => {
				if (!exited()) proc.kill("SIGKILL");
				void signalIfSame(stoppedDescendants, "SIGKILL");
				proc.stdout?.destroy();
				proc.stderr?.destroy();
			}, QUIT_FORCE_KILL_DELAY_MS);
		})();
	};
	const stopOnQuit = onQuit?.(stopForQuit);

	const abort = () => killProcess();
	if (options?.signal) {
		if (options.signal.aborted) {
			killProcess(true);
		} else {
			options.signal.addEventListener("abort", abort, { once: true });
		}
	}

	if (options?.timeout && options.timeout > 0) {
		timeoutId = setTimeout(abort, options.timeout);
	}

	// Keep only bytes within the combined cap (#11360). Close both pipes on overflow so writing
	// descendants cannot keep waitForChildProcess busy after the child exits. Pausing is not
	// enough: Node resumes the child's stdio on exit.
	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		if (truncated) return undefined;
		const remaining = maxBuffer - outputBytes;
		if (data.length <= remaining) {
			outputBytes += data.length;
			return data;
		}
		truncated = true;
		proc.stdout?.destroy();
		proc.stderr?.destroy();
		killProcess();
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};

	proc.stdout?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stdout += stdoutDecoder.write(chunk);
	});

	proc.stderr?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stderr += stderrDecoder.write(chunk);
	});

	let code: number | null;
	try {
		// Do not hang on inherited stdio handles held open by detached descendants.
		code = await waitForChildProcess(proc);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		// Child-process errors (e.g. ENOENT) are failed executions, not host failures.
		code = 1;
		if (!stderr) stderr = error.message;
	} finally {
		// What a command that ended left running keeps running, as it did before.
		job?.release();
		job?.close();
		clearTimeout(timeoutId);
		options?.signal?.removeEventListener("abort", abort);
		stopOnQuit?.();
		quitStoppableCommands.delete(proc);
		await quitStop;
		await treeStop;
		clearTimeout(quitCutId);
		if (quitStop !== undefined || stoppedDescendants.length === 0) {
			clearTimeout(forceKillId);
			// The command the quit stopped has exited: the processes it started that outlived SIGTERM end now.
			if (quitStop !== undefined) await signalIfSame(stoppedDescendants, "SIGKILL");
		} else {
			// Those an abort, a timeout or the output limit stopped keep the rest of their window before SIGKILL, also
			// once the command itself has exited.
			forceKillId?.unref();
		}
	}

	// On truncation, discard any incomplete UTF-8 suffix buffered by either decoder.
	// Flushing it would append a replacement character that was not in the accepted output.
	if (!truncated) {
		stdout += stdoutDecoder.end();
		stderr += stderrDecoder.end();
	}

	// Ended with its tree through its job on Windows, the command exits with status 1; report SIGTERM's code, as for a
	// command `kill` ended.
	const endedByTreeKill = windowsTreeEnded && code === 1 && proc.signalCode === null;
	const exitCode = endedByTreeKill
		? 128 + osConstants.signals.SIGTERM
		: (code ?? (proc.signalCode ? 128 + (osConstants.signals[proc.signalCode] ?? 0) : 1));
	return {
		stdout,
		stderr,
		// A truncated result must never read as success.
		code: truncated && exitCode === 0 ? 1 : exitCode,
		killed,
		truncated,
	};
}
