import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";
import { applyDebugSettingToChildEnvironment } from "../core/debug-setting.ts";
import { HOST_STORAGE_ADAPTERS_ENV, hostStorageAdaptersEnvironment } from "../core/storage/host-adapters.ts";
import { ATOMIC_AI_AGENT } from "./agent-attribution.ts";
import {
	type HelperExecutableOptions,
	type HelperLaunch,
	helperLaunch,
	helperLaunchAsync,
	missingHelperOptions,
} from "./helper-command.ts";
import { type HostChildProcess, isNativeContainedChild } from "./host-spawn.ts";
import { createModuleRequire } from "./module-require.js";

const EXIT_STDIO_IDLE_GRACE_MS = 100;
const EXIT_STDIO_ACTIVE_DRAIN_HARD_CAP_MS = 5_000;
const WINDOWS_EXIT_POLL_INTERVAL_MS = 50;
const WINDOWS_EXIT_CODE_GRACE_MS = 1_000;

/**
 * Thrown by {@link waitForChildProcess} when a child process terminated without delivering an exit status and no
 * creation-time-verified kernel handle could read its real exit code. Never fabricated as `0`.
 */
export class ChildProcessExitStatusUnknownError extends Error {
	override readonly name = "ChildProcessExitStatusUnknownError" as const;
	readonly pid: number | undefined;

	constructor(pid?: number) {
		super(pid === undefined ? "Child process exit status unknown" : `Child process ${pid} exit status unknown`);
		this.pid = pid;
	}
}

export function isChildProcessExitStatusUnknownError(value: unknown): value is ChildProcessExitStatusUnknownError {
	return (
		value instanceof ChildProcessExitStatusUnknownError ||
		(value instanceof Error && value.name === "ChildProcessExitStatusUnknownError")
	);
}

/** Result of polling a held Windows child process handle. */
export interface WindowsProcessExitStatus {
	readonly exited: boolean;
	readonly exitCode?: number | null;
	readonly unknown?: boolean;
}

/** A creation-time- and parent-verified Windows handle to a child process, held until `close()`. */
export interface WindowsProcessExitHandle {
	readonly creationTime: string;
	pollExit(): WindowsProcessExitStatus;
	close(): void;
}

type HoldWindowsProcessExit = (pid: number, expectedCreated?: string | null) => WindowsProcessExitHandle | null;

const NATIVE_WINDOWS_HOST = process.platform === "win32";
let nativeHoldWindowsProcessExit: HoldWindowsProcessExit | null | undefined;

function loadNativeHoldWindowsProcessExit(): HoldWindowsProcessExit | null {
	if (!NATIVE_WINDOWS_HOST) return null;
	if (nativeHoldWindowsProcessExit === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				holdWindowsProcessExit?: HoldWindowsProcessExit;
			};
			nativeHoldWindowsProcessExit = binding.holdWindowsProcessExit ?? null;
		} catch {
			nativeHoldWindowsProcessExit = null;
		}
	}
	return nativeHoldWindowsProcessExit;
}

const retainedWindowsExitHandles = new WeakMap<HostChildProcess, WindowsProcessExitHandle>();

/**
 * On Windows, opens and holds a creation-time-verified process handle right after spawn so
 * {@link waitForChildProcess} can read the child's real exit code via `GetExitCodeProcess` if libuv's `exit` event
 * is delayed or lost. Callers that never await {@link waitForChildProcess} must release it with
 * {@link releaseRetainedWindowsProcessExitHandle}.
 */
export function retainWindowsProcessExitHandle(child: HostChildProcess): void {
	if (process.platform !== "win32" || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (isNativeContainedChild(child) || retainedWindowsExitHandles.has(child)) return;
	const hold = loadNativeHoldWindowsProcessExit();
	if (hold === null) return;
	try {
		const handle = hold(child.pid);
		if (handle !== null) retainedWindowsExitHandles.set(child, handle);
	} catch {
		// Unavailable or refused: waitForChildProcess falls back to waiting for libuv's exit event.
	}
}

/** Closes any spawn-retained Windows process handle not claimed by {@link waitForChildProcess}. */
export function releaseRetainedWindowsProcessExitHandle(child: HostChildProcess): void {
	const handle = retainedWindowsExitHandles.get(child);
	if (handle === undefined) return;
	retainedWindowsExitHandles.delete(child);
	try {
		handle.close();
	} catch {}
}

/** Build the environment for every Atomic child process. */
export { ATOMIC_AI_AGENT } from "./agent-attribution.ts";
export function createChildProcessEnvironment(
	overrides?: NodeJS.ProcessEnv,
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	// The host's adapters are the default. A caller that set the variable itself, to another map or to nothing, keeps
	// its choice; an unchanged copy of this process's environment does not count as a choice.
	const callerChose =
		baseEnv !== process.env && baseEnv[HOST_STORAGE_ADAPTERS_ENV] !== process.env[HOST_STORAGE_ADAPTERS_ENV];
	const env = {
		...baseEnv,
		...(callerChose ? {} : hostStorageAdaptersEnvironment()),
		...overrides,
		AI_AGENT: ATOMIC_AI_AGENT,
	};
	applyDebugSettingToChildEnvironment(env);
	return env;
}

export type WaitForChildProcessOptions = {
	platform?: NodeJS.Platform;
	/**
	 * Caller's abort or timeout boundary. On Windows without a verified native handle, `waitForChildProcess` waits for
	 * libuv's real `exit` event rather than guessing after 1 s; once `signal` aborts and the process is confirmed gone
	 * without an `exit` event, the wait fails with {@link ChildProcessExitStatusUnknownError} instead of hanging.
	 */
	signal?: AbortSignal;
	isWindowsProcessAlive?: (pid: number) => boolean;
	holdWindowsProcessExit?: (pid: number) => WindowsProcessExitHandle | null;
	windowsExitPollIntervalMs?: number;
	windowsExitCodeGraceMs?: number;
};

const WINDOWS_SHELL_COMMANDS = new Set(["bun", "npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

/**
 * How {@link spawnProcess} and {@link spawnProcessSync} start `command` from `cwd` with `env`: a bare name becomes its
 * absolute path in PATH's absolute directories, never the working directory. On Windows `.cmd` and `.bat` shims count,
 * as these functions run them through cmd.exe.
 */
export function processLaunch(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): HelperLaunch {
	return helperLaunch(command, { ...launchSearch(options), shellScripts: process.platform === "win32" });
}

/** {@link processLaunch} without blocking the event loop. */
export function processLaunchAsync(
	command: string,
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<HelperLaunch> {
	return helperLaunchAsync(command, { ...launchSearch(options), shellScripts: process.platform === "win32" });
}

function launchSearch(options: { cwd?: string; env?: NodeJS.ProcessEnv }): HelperExecutableOptions {
	return {
		env: options.env ? createChildProcessEnvironment(undefined, options.env) : createChildProcessEnvironment(),
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
	};
}

/**
 * Start `command` as {@link processLaunch} finds it: a bare name only from PATH's absolute directories, never from the
 * working directory. A name no such directory holds fails as a program that is not installed does (`ENOENT`).
 */
export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	// Through a shell `command` is a command line the shell reads, as it always was.
	if (options.shell) return spawnChild(command, args, options);
	const cwd = typeof options.cwd === "string" ? options.cwd : options.cwd?.pathname;
	return spawnLaunchedProcess(processLaunch(command, { cwd, env: options.env }), args, options);
}

/** The synchronous {@link spawnProcess}. */
export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	if (options.shell) return spawnChildSync(command, args, options);
	const cwd = typeof options.cwd === "string" ? options.cwd : options.cwd?.pathname;
	return spawnLaunchedProcessSync(processLaunch(command, { cwd, env: options.env }), args, options);
}

/**
 * A shell reads the program of a command line up to the first space: a program looked up to a path with spaces runs
 * through one only quoted.
 */
function shellReadable(launch: HelperLaunch, shell: SpawnOptions["shell"]): HelperLaunch {
	if (!shell || launch.missing !== undefined || !isAbsolute(launch.file)) return launch;
	return {
		file: process.platform === "win32" ? `"${launch.file}"` : `'${launch.file.replaceAll("'", `'\\''`)}'`,
	};
}

/** {@link spawnProcess} for a command its caller has looked up with {@link processLaunch} or {@link processLaunchAsync}. */
export function spawnLaunchedProcess(
	launch: HelperLaunch,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnLaunchedProcess(launch: HelperLaunch, args: string[], options: SpawnOptions): ChildProcess;
export function spawnLaunchedProcess(launch: HelperLaunch, args: string[], options: SpawnOptions): ChildProcess {
	// A program no allowed directory holds fails as a missing one does; cross-spawn would look in the working directory.
	if (launch.missing !== undefined) {
		return nodeSpawn(launch.file, args, { ...childEnvironment(options), ...missingHelperOptions(launch) });
	}
	return spawnChild(shellReadable(launch, options.shell).file, args, options);
}

/** `file` with Atomic's child environment, through cross-spawn on Windows. */
function spawnChild(file: string, args: string[], options: SpawnOptions): ChildProcess {
	const childOptions = childEnvironment(options);
	return process.platform === "win32" ? crossSpawn(file, args, childOptions) : nodeSpawn(file, args, childOptions);
}

function childEnvironment<T extends { env?: NodeJS.ProcessEnv }>(options: T): T {
	return {
		...options,
		env: options.env ? createChildProcessEnvironment(undefined, options.env) : createChildProcessEnvironment(),
	};
}

/** The synchronous {@link spawnLaunchedProcess}. */
export function spawnLaunchedProcessSync(
	launch: HelperLaunch,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	if (launch.missing !== undefined) {
		return nodeSpawnSync(launch.file, args, { ...childEnvironment(options), ...missingHelperOptions(launch) });
	}
	return spawnChildSync(shellReadable(launch, options.shell).file, args, options);
}

function spawnChildSync(
	file: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	const childOptions = childEnvironment(options);
	return process.platform === "win32"
		? crossSpawn.sync(file, args, childOptions)
		: nodeSpawnSync(file, args, childOptions);
}

export function isWindowsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function mapSignalExitCode(
	code: number | null,
	signal: NodeJS.Signals | null,
	platform: NodeJS.Platform,
): number | null {
	if (code !== null || signal === null || platform === "win32") return code;
	const signalNumber = osConstants.signals[signal] ?? 0;
	return 128 + signalNumber;
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a short fixed deadline
 * measured from `exit`, or finite post-exit output still being written past that
 * deadline is silently lost (earendil-works/pi#5303). Instead, after `exit` we wait
 * for the pipes to fall idle: the grace timer is re-armed on every chunk, so finite
 * post-exit writers drain while active, while a quiet inherited handle (e.g. a
 * Windows daemonized descendant that never lets `close` fire) releases promptly
 * after the grace elapses. A longer active-drain hard cap is armed once on `exit`
 * so an endlessly noisy descendant cannot keep the wait pending forever.
 */
export function waitForChildProcess(
	child: HostChildProcess,
	options: WaitForChildProcessOptions = {},
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitIdleTimer: NodeJS.Timeout | undefined;
		let postExitActiveDrainHardCapTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;
		let windowsExitPoll: NodeJS.Timeout | undefined;
		let windowsExitCodeGraceTimer: NodeJS.Timeout | undefined;
		let windowsExitCodeFallback: NodeJS.Immediate | undefined;
		const platform = options.platform ?? process.platform;
		const processAlive = options.isWindowsProcessAlive ?? isWindowsProcessAlive;
		const windowsExitPollIntervalMs = options.windowsExitPollIntervalMs ?? WINDOWS_EXIT_POLL_INTERVAL_MS;
		const windowsExitCodeGraceMs = options.windowsExitCodeGraceMs ?? WINDOWS_EXIT_CODE_GRACE_MS;

		const claimedRetained = retainedWindowsExitHandles.get(child);
		if (claimedRetained !== undefined) retainedWindowsExitHandles.delete(child);

		let exitHandle: WindowsProcessExitHandle | undefined = claimedRetained;
		const closeExitHandle = () => {
			if (exitHandle === undefined) return;
			const handle = exitHandle;
			exitHandle = undefined;
			try {
				handle.close();
			} catch {}
		};

		// A failed async spawn (e.g. NativeChildProcess / ContainedProcess ENOENT) sets exitCode to -errno with
		// pid === undefined before emitting "error" on a later turn: only treat a child as already exited when it
		// actually started (has a positive pid), so we stay attached for the async "error" event.
		const alreadyExited =
			child.pid !== undefined && child.pid > 0 && (child.exitCode !== null || child.signalCode !== null);
		const needsWindowsFallback = platform === "win32" && Boolean(child.pid) && !isNativeContainedChild(child);

		if (alreadyExited || !needsWindowsFallback) {
			closeExitHandle();
		} else if (exitHandle === undefined && child.pid) {
			if (options.holdWindowsProcessExit !== undefined) {
				try {
					exitHandle = options.holdWindowsProcessExit(child.pid) ?? undefined;
				} catch {
					exitHandle = undefined;
				}
			} else if (options.isWindowsProcessAlive === undefined) {
				const hold = loadNativeHoldWindowsProcessExit();
				if (hold !== null) {
					try {
						exitHandle = hold(child.pid) ?? undefined;
					} catch {
						exitHandle = undefined;
					}
				}
			}
		}

		const cleanup = () => {
			if (windowsExitPoll) {
				clearInterval(windowsExitPoll);
				windowsExitPoll = undefined;
			}
			if (postExitIdleTimer) {
				clearTimeout(postExitIdleTimer);
				postExitIdleTimer = undefined;
			}
			if (postExitActiveDrainHardCapTimer) {
				clearTimeout(postExitActiveDrainHardCapTimer);
				postExitActiveDrainHardCapTimer = undefined;
			}
			if (windowsExitCodeGraceTimer) {
				clearTimeout(windowsExitCodeGraceTimer);
				windowsExitCodeGraceTimer = undefined;
			}
			if (windowsExitCodeFallback) {
				clearImmediate(windowsExitCodeFallback);
				windowsExitCodeFallback = undefined;
			}
			closeExitHandle();
			options.signal?.removeEventListener("abort", onAbort);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const failUnknownExitStatus = () => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			reject(new ChildProcessExitStatusUnknownError(child.pid));
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitIdleTimer) clearTimeout(postExitIdleTimer);
			postExitIdleTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_IDLE_GRACE_MS);
		};

		const armActiveDrainHardCapTimer = () => {
			if (postExitActiveDrainHardCapTimer) return;
			postExitActiveDrainHardCapTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_ACTIVE_DRAIN_HARD_CAP_MS);
		};

		const onData = () => {
			// Output is still arriving after exit; keep extending the idle grace
			// so active finite writers can drain without truncating the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (windowsExitPoll) {
				clearInterval(windowsExitPoll);
				windowsExitPoll = undefined;
			}
			if (windowsExitCodeGraceTimer) {
				clearTimeout(windowsExitCodeGraceTimer);
				windowsExitCodeGraceTimer = undefined;
			}
			if (windowsExitCodeFallback) {
				clearImmediate(windowsExitCodeFallback);
				windowsExitCodeFallback = undefined;
			}
			exited = true;
			exitCode = mapSignalExitCode(code, signal, platform);
			maybeFinalizeAfterExit();
			if (!settled) {
				armActiveDrainHardCapTimer();
				armIdleTimer();
			}
		};

		const resolveWindowsFallback = () => {
			if (exited || settled) return;
			if (child.exitCode !== null || child.signalCode !== null) {
				onExit(child.exitCode, child.signalCode);
				return;
			}
			if (exitHandle !== undefined) {
				let status: WindowsProcessExitStatus | undefined;
				try {
					status = exitHandle.pollExit();
				} catch {
					status = undefined;
				}
				if (status?.exited && !status.unknown && status.exitCode !== undefined && status.exitCode !== null) {
					onExit(status.exitCode, null);
					return;
				}
				// The held handle could not prove an exit code: drop it and keep waiting for libuv unless the caller stopped.
				closeExitHandle();
				if (!options.signal?.aborted) {
					return;
				}
			}
			// Never fabricate exit code 0 without proof from libuv or a verified kernel handle.
			failUnknownExitStatus();
		};

		const armWindowsExitCodeGraceTimer = () => {
			if (windowsExitCodeGraceTimer || windowsExitCodeFallback || exited || settled) return;
			if (windowsExitPoll) {
				clearInterval(windowsExitPoll);
				windowsExitPoll = undefined;
			}
			windowsExitCodeGraceTimer = setTimeout(() => {
				windowsExitCodeGraceTimer = undefined;
				// A loop held past the grace runs this timer before the events that arrived meanwhile, the child's exit among
				// them: let those go first, so a reported exit code or signal always wins over the fallback.
				windowsExitCodeFallback = setImmediate(() => {
					windowsExitCodeFallback = undefined;
					resolveWindowsFallback();
				});
			}, windowsExitCodeGraceMs);
		};

		const pollWindowsExit = () => {
			if (
				!needsWindowsFallback ||
				!child.pid ||
				exited ||
				settled ||
				windowsExitCodeGraceTimer ||
				windowsExitCodeFallback
			) {
				return;
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				onExit(child.exitCode, child.signalCode);
				return;
			}
			if (exitHandle !== undefined) {
				let status: WindowsProcessExitStatus | undefined;
				try {
					status = exitHandle.pollExit();
				} catch {
					status = undefined;
				}
				if (status === undefined || status.unknown) {
					// The handle cannot read an exit status: close it and fall back to waiting for libuv unless the caller
					// already aborted/timed out and the process is confirmed gone.
					closeExitHandle();
					if (options.signal?.aborted) {
						if (status?.exited || !processAlive(child.pid)) {
							armWindowsExitCodeGraceTimer();
						}
					} else if (windowsExitPoll) {
						clearInterval(windowsExitPoll);
						windowsExitPoll = undefined;
					}
					return;
				}
				if (status.exited) {
					armWindowsExitCodeGraceTimer();
				}
				return;
			}
			// Without a verified handle, never arm a fixed-deadline fallback while the caller has not stopped.
			if (!options.signal?.aborted) return;
			if (!processAlive(child.pid)) {
				armWindowsExitCodeGraceTimer();
			}
		};

		const onAbort = () => {
			if (!needsWindowsFallback || exited || settled) return;
			if (exitHandle === undefined && !windowsExitPoll && !windowsExitCodeGraceTimer && !windowsExitCodeFallback) {
				windowsExitPoll = setInterval(pollWindowsExit, windowsExitPollIntervalMs);
			}
			pollWindowsExit();
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			finalize(mapSignalExitCode(code, signal, platform));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		if (alreadyExited) {
			onExit(child.exitCode, child.signalCode);
			return;
		}

		if (needsWindowsFallback) {
			if (exitHandle !== undefined) {
				windowsExitPoll = setInterval(pollWindowsExit, windowsExitPollIntervalMs);
			}
			if (options.signal !== undefined) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		}
	});
}
