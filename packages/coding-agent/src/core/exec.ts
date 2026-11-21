/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createChildProcessEnvironment, waitForChildProcess } from "../utils/child-process.ts";
import { type HelperLaunch, helperLaunchAsync, missingHelperOptions } from "../utils/helper-command.ts";
import { type HostChildProcess, spawnHostProcess } from "../utils/host-spawn.ts";
import {
	descendantsOf,
	descendantsOfNow,
	type IdentifiedProcess,
	signalIfSame,
	signalIfSameNow,
} from "./process-descendants.js";
import { terminateProcessDescendants } from "./process-tree-containment.ts";

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
 * The files a start of `command` by name on Windows may run: the name as it is when it has an extension, and the name
 * with each extension PATHEXT names or Node or Bun tries whatever it names.
 */
function windowsNames(command: string, env: NodeJS.ProcessEnv): string[] {
	const extensions = new Set([".com", ".exe", ".bat", ".cmd"]);
	for (const extension of (windowsVariable(env, "PATHEXT") ?? "").split(";")) {
		const trimmed = extension.trim().toLowerCase();
		if (trimmed.startsWith(".")) extensions.add(trimmed);
	}
	return [
		...(extname(command) === "" ? [] : [command]),
		...[...extensions].map((extension) => `${command}${extension}`),
	];
}

/** Variable `name` as a program started with `env` gets it: of several spellings, the first in sorted order. */
function windowsVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env)
		.filter((candidate) => candidate.toUpperCase() === name)
		.sort()[0];
	return key === undefined ? undefined : env[key];
}

/**
 * The folders a start by name on Windows searches besides PATH's absolute directories: the working directory, which it
 * searches first, and the folders PATH's empty and relative entries name in it.
 */
function windowsWorkingFolders(cwd: string, env: NodeJS.ProcessEnv): string[] {
	const folders = [cwd];
	for (const raw of (windowsVariable(env, "PATH") ?? process.env.PATH ?? "").split(";")) {
		const entry = raw.trim().replace(/^"(.*)"$/, "$1");
		if (entry === "" || !isAbsolute(entry)) folders.push(resolve(cwd, entry));
	}
	return folders;
}

/**
 * How Windows starts `command` from `cwd`. A path runs as written. A name runs as before, found by the runtime's own
 * search (Bun's also runs `.cmd` and `.bat` shims such as npm's), when neither the working directory nor a folder an
 * empty or relative PATH entry names holds anything it could start: that search then finds only what PATH's absolute
 * directories hold. Otherwise it is looked up in PATH's absolute directories only and started by its absolute path, or
 * fails as a missing program does, so a project folder cannot supply it.
 */
async function windowsLaunch(
	command: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
	signal: AbortSignal,
): Promise<HelperLaunch> {
	if (/[\\/:]/.test(command)) return { file: command };
	const names = windowsNames(command, env);
	for (const folder of windowsWorkingFolders(cwd, env)) {
		for (const name of names) {
			if (await untilAborted(couldStart(join(folder, name)), signal)) {
				return helperLaunchAsync(command, { env, cwd, signal });
			}
		}
	}
	return { file: command };
}

/** Whether a start may run `path`: anything there but a directory, an app execution alias included. */
async function couldStart(path: string): Promise<boolean> {
	try {
		return !(await stat(path)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/** `work`'s result, or `signal`'s reason as soon as it aborts, whatever `work` still waits for. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Ends the lookup of `command`'s program, which runs before it starts, on what ends a running command: its abort
 * signal, its timeout and its session's quit. Returns their release.
 */
function stopLookupOn(
	lookup: AbortController,
	options: ExecOptions | undefined,
	onQuit: ((stop: () => void) => () => void) | undefined,
): () => void {
	const stop = () => lookup.abort();
	options?.signal?.addEventListener("abort", stop, { once: true });
	if (options?.signal?.aborted) stop();
	const timer = options?.timeout && options.timeout > 0 ? setTimeout(stop, options.timeout) : undefined;
	const stopOnQuit = onQuit?.(stop);
	return () => {
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", stop);
		stopOnQuit?.();
	};
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

	// Pass the environment explicitly. Bun snapshots the process environment
	// at startup for spawns that omit `env`, so an inherited default would
	// still carry values this process deleted from `process.env` — including
	// the interactive-engine control variables and their --api-key. Preserve
	// Atomic's child attribution in the same explicit environment.
	const env = createChildProcessEnvironment();
	/** How long the program's lookup took, which counts against the timeout. */
	let lookupMs = 0;
	// The arguments as they are now: a caller may reuse its array while the program is looked up.
	const argv = [...args];
	let launch: HelperLaunch = { file: command };
	if (process.platform === "win32") {
		// Windows looks for a program named without a path in the working directory before PATH (see windowsLaunch).
		const lookup = new AbortController();
		const releaseLookupStops = stopLookupOn(lookup, options, onQuit);
		const lookupStarted = performance.now();
		try {
			launch = await windowsLaunch(command, env, cwd, lookup.signal);
		} catch (error) {
			if (!lookup.signal.aborted) throw error;
		} finally {
			// From here until the command's own stops are in place everything runs at once: no stop can arrive between.
			releaseLookupStops();
			lookupMs = performance.now() - lookupStarted;
		}
		// Stopped while it was looked up, or as the lookup finished: nothing starts, and the result is a command's that
		// was stopped at once.
		if (lookup.signal.aborted) {
			return { stdout: "", stderr: "", code: 128 + osConstants.signals.SIGTERM, killed: true, truncated: false };
		}
	}
	// Without fork where that costs the host time in proportion to its memory (#5345).
	const proc = spawnHostProcess(launch.file, argv, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		// A command a quit would stop must not outlive this process when it is killed instead.
		endWithParent: onQuit !== undefined,
		...missingHelperOptions(launch),
	});
	// Until it settles; one that exited by then is left alone (see killQuitStoppableCommandsNow).
	if (onQuit !== undefined && proc.pid !== undefined) quitStoppableCommands.add(proc);

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
	let treeStop: Promise<boolean> | undefined;
	/**
	 * Ends the command and the processes it started: on POSIX those below it in its process group, read while it still
	 * runs, get SIGTERM with it; on Windows those below it end at once, each through a handle of its own, then the
	 * command itself through its handle. Resolves whether it did: a command that ended on its own first, during the
	 * few milliseconds the read takes, leaves the processes it started, as one that ended before.
	 */
	const endTree = (): Promise<boolean> => {
		treeStop ??= (async () => {
			const pid = proc.pid;
			if (pid === undefined || exited()) return false;
			if (process.platform === "win32") {
				// This process has not seen the command exit, so it still holds its handle and `pid` names it.
				terminateProcessDescendants(pid);
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
		timeoutId = setTimeout(abort, Math.max(0, options.timeout - lookupMs));
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

	const exitCode = code ?? (proc.signalCode ? 128 + (osConstants.signals[proc.signalCode] ?? 0) : 1);
	return {
		stdout,
		stderr,
		// A truncated result must never read as success.
		code: truncated && exitCode === 0 ? 1 : exitCode,
		killed,
		truncated,
	};
}
