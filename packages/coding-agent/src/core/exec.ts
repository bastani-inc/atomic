/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { constants as bufferConstants } from "node:buffer";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { createChildProcessEnvironment, waitForChildProcess } from "../utils/child-process.ts";
import { type HelperLaunch, helperLaunchAsync, missingHelperOptions } from "../utils/helper-command.ts";
import { spawnHostProcess } from "../utils/host-spawn.ts";
import { descendantsOf, type IdentifiedProcess, signalIfSame } from "./process-descendants.js";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;
/**
 * How long a command its session's quit ends may take to exit after SIGTERM before it gets SIGKILL. Short, so that the
 * session's shutdown handlers still have most of the quit's grace period once every such command has ended.
 */
const QUIT_FORCE_KILL_DELAY_MS = 1000;

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
 * stop starts (on Windows they end with this process instead). A command that already exited is left as it is.
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
		// Windows looks for a program named without a path in the working directory before PATH: look it up in PATH's
		// absolute directories instead, so a project folder cannot supply it. A name found nowhere fails as before.
		const lookup = new AbortController();
		const releaseLookupStops = stopLookupOn(lookup, options, onQuit);
		const lookupStarted = performance.now();
		try {
			launch = await helperLaunchAsync(command, { env, cwd, signal: lookup.signal });
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
		...missingHelperOptions(launch),
	});

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

	const killProcess = () => {
		if (killed) return;
		killed = true;
		proc.kill("SIGTERM");
		forceKillId = setTimeout(() => {
			// `proc.killed` only says a signal was sent, so check whether the child actually exited.
			if (!exited()) {
				proc.kill("SIGKILL");
			}
		}, FORCE_KILL_DELAY_MS);
	};

	/** The processes the command had started when the quit stopped it, read while it still ran. */
	let quitDescendants: readonly IdentifiedProcess[] = [];
	let quitStop: Promise<void> | undefined;
	const stopForQuit = () => {
		// A command that never started has nothing to end; its start failure settles it. One that already exited keeps
		// its result, and the output its descendants still write is waited for as before.
		const pid = proc.pid;
		if (pid === undefined || exited() || quitStop !== undefined) return;
		quitStop = (async () => {
			// Read before the command is signalled: once it exits, the processes it started are no longer below it.
			const descendants = await descendantsOf(pid);
			// A command that ended on its own meanwhile leaves the processes it started, as one that ended before.
			if (exited()) return;
			quitDescendants = descendants;
			killProcess();
			await signalIfSame(quitDescendants, "SIGTERM");
			// The command has a short window to end; then it gets SIGKILL, also when its caller already stopped it, and
			// output its descendants still hold open is no longer waited for.
			quitCutId = setTimeout(() => {
				if (!exited()) proc.kill("SIGKILL");
				void signalIfSame(quitDescendants, "SIGKILL");
				proc.stdout?.destroy();
				proc.stderr?.destroy();
			}, QUIT_FORCE_KILL_DELAY_MS);
		})();
	};
	const stopOnQuit = onQuit?.(stopForQuit);

	if (options?.signal) {
		if (options.signal.aborted) {
			killProcess();
		} else {
			options.signal.addEventListener("abort", killProcess, { once: true });
		}
	}

	if (options?.timeout && options.timeout > 0) {
		timeoutId = setTimeout(killProcess, Math.max(0, options.timeout - lookupMs));
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
		clearTimeout(forceKillId);
		options?.signal?.removeEventListener("abort", killProcess);
		stopOnQuit?.();
		await quitStop;
		clearTimeout(quitCutId);
		// The command the quit stopped has exited: the processes it started that outlived SIGTERM end now.
		await signalIfSame(quitDescendants, "SIGKILL");
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
