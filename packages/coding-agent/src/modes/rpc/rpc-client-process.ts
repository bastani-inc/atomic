import { type ChildProcess, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import type { SessionTrustDecisions, StartupExtensionCheck } from "../../core/project-trust-state.ts";
import { ENGINE_SESSION_STORAGE_FLAG } from "../../core/session-storage.js";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { flushPersistentCompileCache } from "../../utils/compile-cache.ts";
import {
	INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
	type InteractiveEngineBootstrapHandle,
	removeOwnedInteractiveEngineBootstrapAsync,
	writeInteractiveEngineBootstrapAsync,
} from "../../utils/interactive-engine-bootstrap.ts";
import { scrubInteractiveEngineEnv } from "../../utils/interactive-engine-env.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { sleep } from "../../utils/sleep.ts";
import { adoptPrewarmedEngine, engineLaunch, type PrewarmLaunchBasis } from "../interactive-engine/engine-prewarm.ts";

export interface PreparedRpcClientBootstrap {
	readonly guardianFile: string;
	readonly bootstrap: InteractiveEngineBootstrapHandle;
}

export interface RpcClientProcessOptions {
	cliPath: string;
	cliArgs: string[];
	cwd?: string;
	env?: Record<string, string>;
	runtimeExecutable?: string;
	runtimeArgs?: string[];
	interactiveEngine: boolean;
	/** Credential handed to the engine child through the bootstrap file, never argv or env. */
	interactiveEngineApiKey?: string;
	preparedBootstrap?: PreparedRpcClientBootstrap;
}

const guardianFiles = new WeakMap<ChildProcess, string>();
const bootstrapHandles = new WeakMap<ChildProcess, InteractiveEngineBootstrapHandle>();

export async function prepareRpcClientBootstrap(
	interactiveEngineApiKey?: string,
	trustDecisions?: SessionTrustDecisions,
	startedSessionId?: string,
	startupExtensionCheck?: StartupExtensionCheck,
): Promise<PreparedRpcClientBootstrap> {
	const guardianFile = join(tmpdir(), `atomic-engine-guardian-${process.pid}-${crypto.randomUUID()}`);
	const bootstrap = await writeInteractiveEngineBootstrapAsync({
		hostPid: process.pid,
		guardFile: guardianFile,
		projectResourceWithdrawals: true,
		queuedDeliveries: true,
		...(interactiveEngineApiKey ? { apiKey: interactiveEngineApiKey } : {}),
		...(trustDecisions ? { trustDecisions } : {}),
		...(startedSessionId !== undefined ? { startedSessionId } : {}),
		...(startupExtensionCheck ? { startupExtensionCheck } : {}),
	});
	return { guardianFile, bootstrap };
}

export function createRpcClientProcessEnvironment(
	overrides?: Record<string, string>,
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return scrubInteractiveEngineEnv(createChildProcessEnvironment(overrides, baseEnv));
}

export function spawnRpcClientProcess(options: RpcClientProcessOptions): ChildProcess {
	const guardianFile =
		options.preparedBootstrap?.guardianFile ??
		(options.interactiveEngine
			? join(tmpdir(), `atomic-engine-guardian-${process.pid}-${crypto.randomUUID()}`)
			: undefined);
	// The engine's startup metadata travels in a 0600 file rather than the
	// environment: a Bun child spawned without an explicit `env` inherits the
	// runtime's launch-time environment, so anything placed here would remain
	// reachable by every descendant of the engine no matter what the engine
	// deletes from its own `process.env` afterwards.
	const bootstrap = options.preparedBootstrap?.bootstrap;
	const cliArgs = bootstrap
		? [...options.cliArgs, INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, bootstrap.path]
		: options.cliArgs;
	let child: ChildProcess;
	try {
		if (options.interactiveEngine) markLifecycleTiming("interactive-engine-spawn");
		const launch = engineLaunch(options);
		// A child prewarmed exactly as this one would start has already loaded the application.
		// An earlier version of the prewarm module, still loaded beside this one after an update, reports no basis.
		const adoption: { basis: PrewarmLaunchBasis } = { basis: "unchanged" };
		const prewarmed = options.interactiveEngine
			? adoptPrewarmedEngine(launch, cliArgs, (adopted) => {
					adoption.basis = adopted;
				})
			: undefined;
		// A fresh engine loads the same module graph as this host: let it start from this host's compile cache. On
		// Windows, where writing a cold cache takes seconds, so does a host running an engine prewarmed with environment
		// its arguments or settings add: without that environment it would have written the cache here and started a
		// fresh engine, and otherwise the write waits for its quit.
		const writesCache = !prewarmed || (adoption.basis === "derived" && process.platform === "win32");
		if (options.interactiveEngine && writesCache) flushPersistentCompileCache();
		child =
			prewarmed ??
			spawn(launch.command, [...launch.args, ...cliArgs], {
				cwd: launch.cwd,
				env: launch.env,
				detached: launch.detached,
				stdio: ["pipe", "pipe", "pipe"],
			});
	} catch (error) {
		void removeOwnedInteractiveEngineBootstrapAsync(bootstrap);
		throw error;
	}
	if (guardianFile) guardianFiles.set(child, guardianFile);
	if (bootstrap) {
		bootstrapHandles.set(child, bootstrap);
		// The child unlinks the record after reading it; this handle-scoped cleanup
		// removes the directory this process created, and only that directory.
		child.once("error", () => void removeOwnedInteractiveEngineBootstrapAsync(bootstrap));
		child.once("exit", () => void removeOwnedInteractiveEngineBootstrapAsync(bootstrap));
	}
	if (options.interactiveEngine && child.pid) {
		trackDetachedChildPid(child.pid);
		child.once("exit", () => untrackDetachedChildPid(child.pid!));
	}
	return child;
}

/**
 * How long a SIGTERMed interactive engine may spend running extension
 * `session_shutdown` handlers before its guardian and then a tree kill take over.
 * Builtin shutdown (MCP servers, session storage) routinely exceeds a
 * few hundred milliseconds on a loaded machine.
 */
export const ENGINE_SHUTDOWN_GRACE_MS = 5_000;
const RPC_CHILD_SHUTDOWN_GRACE_MS = 250;
/** How long the engine's guardian, and on Windows a tree kill, may take to end the engine. */
const ENGINE_KILL_STEP_MS = 500;
/**
 * How long a force-killed child may take to have its exit reported before stop
 * declares it unkillable. On Windows SIGTERM and SIGKILL both become
 * TerminateProcess, which only starts termination, and a loaded runner has
 * reported such an exit more than 500 ms later.
 */
const KILLED_CHILD_EXIT_REPORT_MS = 5_000;

/** Whether `pending` settles within `ms`. */
async function settlesWithin(pending: Promise<void>, ms: number): Promise<boolean> {
	const deadline = new AbortController();
	try {
		return await Promise.race([pending.then(() => true), sleep(ms, deadline.signal).then(() => false)]);
	} finally {
		deadline.abort();
	}
}

/**
 * The stop file that tells an engine's guardian to end it. Writing it never holds a stop up: a stop goes on to its
 * kill whether the file was written, could not be, or not yet. A write still in progress when the stop ends is not
 * waited for: the file is removed once that write settles. Otherwise removing it waits at most one step's window and
 * reports a failure within it.
 */
function guardianStopFile(path: string): { write(): void; remove(): Promise<void> } {
	let written: Promise<void> | undefined;
	let writing = false;
	return {
		write() {
			writing = true;
			const settled = () => {
				writing = false;
			};
			written = writeFile(path, "stop").then(settled, settled);
		},
		async remove() {
			if (writing) {
				void written?.then(() => rm(path, { force: true })).catch(() => {});
				return;
			}
			const removed = rm(path, { force: true });
			removed.catch(() => {});
			await settlesWithin(removed, ENGINE_KILL_STEP_MS);
		},
	};
}

/**
 * Stop `child`: ask it to end, give it a bounded grace period, then escalate to the engine's guardian and a kill.
 *
 * The ask is SIGTERM, which a started engine handles by running its shutdown. On Windows Node ends a process at
 * once for any signal, so there an engine stopped with `graceful` has its stdin closed instead: every engine version
 * treats the end of its input as the end of its session and shuts down as it does on SIGTERM elsewhere. Pass
 * `graceful` only for an engine that has reported ready; before that it handles neither, and a SIGTERM ends it at
 * once on every platform.
 *
 * `shutdownComplete` settles when such an engine says its shutdown has run. It is then given
 * {@link ENGINE_KILL_STEP_MS} to exit and otherwise ended alone, rather than waited for while the runtime does its
 * own exit work, such as writing a compile cache, which can take seconds on Windows.
 *
 * `hostSignaled` stops an engine because its host was signalled or lost its terminal. On Linux and macOS the ask is
 * then SIGHUP, the hangup of the host it serves: such an engine, in a session of its own with no terminal, runs the
 * same shutdown and then ends its own process group, as a hangup ends a terminal's job.
 *
 * Temporary files never hold the stop up for longer than one step's window, so a stalled or failing temporary
 * directory can neither keep the engine running nor keep the stop from returning.
 */
export async function terminateRpcClientProcess(
	child: ChildProcess,
	processTree: boolean,
	graceful = false,
	shutdownComplete?: Promise<void>,
	hostSignaled = false,
): Promise<void> {
	const bootstrap = bootstrapHandles.get(child);
	if (bootstrap) await settlesWithin(removeOwnedInteractiveEngineBootstrapAsync(bootstrap), ENGINE_KILL_STEP_MS);
	if (child.exitCode !== null || child.signalCode !== null) return;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	child.once("exit", resolveExit);
	const guardianFile = guardianFiles.get(child);
	const stopFile = guardianFile === undefined ? undefined : guardianStopFile(guardianFile);
	const inputClosed = graceful && processTree && process.platform === "win32" && child.stdin !== null;
	const stop = async (): Promise<void> => {
		if (inputClosed) child.stdin?.end();
		else child.kill(hostSignaled && processTree && process.platform !== "win32" ? "SIGHUP" : "SIGTERM");
		let shutDown = false;
		const ended =
			inputClosed && shutdownComplete
				? Promise.race([
						exited,
						shutdownComplete.then(() => {
							shutDown = true;
						}),
					])
				: exited;
		if (await settlesWithin(ended, processTree ? ENGINE_SHUTDOWN_GRACE_MS : RPC_CHILD_SHUTDOWN_GRACE_MS)) {
			if (shutDown && !(await settlesWithin(exited, ENGINE_KILL_STEP_MS))) {
				// Only the runtime's own exit work is left. End the engine alone, through its handle: its own exit would
				// have left any process it started running too.
				child.kill("SIGKILL");
				if (!(await settlesWithin(exited, KILLED_CHILD_EXIT_REPORT_MS))) {
					throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
				}
			}
			return;
		}
		if (processTree && stopFile) {
			stopFile.write();
			if (await settlesWithin(exited, ENGINE_KILL_STEP_MS)) return;
		}
		if (processTree && child.pid) killProcessTree(child.pid);
		else child.kill("SIGKILL");
		let reportMs = KILLED_CHILD_EXIT_REPORT_MS;
		// The tree kill runs taskkill on Windows, which can fail or take long; then the handle ends the engine, within
		// the same overall bound.
		if (inputClosed && !(await settlesWithin(exited, ENGINE_KILL_STEP_MS))) {
			reportMs -= ENGINE_KILL_STEP_MS;
			child.kill("SIGKILL");
		}
		if (!(await settlesWithin(exited, reportMs))) {
			throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
		}
	};
	try {
		await stop();
	} catch (error) {
		// The stop's own failure is the one reported.
		await stopFile?.remove().catch(() => {});
		throw error;
	}
	await stopFile?.remove();
}

export function createInteractiveJsonlOptions(enabled: boolean): { maxBytesPerTurn?: number } {
	return enabled ? { maxBytesPerTurn: 256 * 1024 } : {};
}

/**
 * CLI args for a replacement engine child: drop whatever session flag the
 * previous generation carried and bind the replacement to `sessionId`, so a
 * restart resumes the same conversation instead of starting a fresh one.
 */
export function restartCliArgs(
	args: readonly string[] | undefined,
	sessionId: string | undefined,
	sessionDirectory?: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < (args?.length ?? 0); index += 1) {
		const value = args![index]!;
		if (
			value === "--no-session" ||
			value === "--continue" ||
			value === "-c" ||
			value === "--resume" ||
			value === "-r"
		)
			continue;
		if (
			value === "--session" ||
			value === "--session-id" ||
			value === "--fork" ||
			value === "--import" ||
			(value === "--session-dir" && sessionDirectory !== undefined) ||
			(value === ENGINE_SESSION_STORAGE_FLAG && (sessionDirectory !== undefined || sessionId === undefined))
		) {
			index += 1;
			continue;
		}
		result.push(value);
	}
	if (sessionId === undefined) result.push("--no-session");
	else result.push("--session", sessionId);
	if (sessionDirectory !== undefined) result.push("--session-dir", sessionDirectory);
	return result;
}

const MAX_STDERR_BYTES = 256 * 1024;

/** Keep only the tail of a child's stderr, so a noisy child cannot grow the host. */
export function appendBoundedStderr(existing: string, chunk: string): string {
	const next = existing + chunk;
	if (Buffer.byteLength(next, "utf8") <= MAX_STDERR_BYTES) return next;
	const marker = "\n[stderr truncated]";
	const bytes = Buffer.from(next);
	let start = bytes.length - MAX_STDERR_BYTES + Buffer.byteLength(marker);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return `${bytes.subarray(start).toString("utf8")}${marker}`;
}

/** Batch noisy child output outside the pipe callback without filesystem work. */
export function createStderrReporter(report: (message: string) => void): (data: string) => void {
	let pending = "";
	let scheduled = false;
	return (data) => {
		pending = appendBoundedStderr(pending, data);
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => {
			const message = pending;
			pending = "";
			scheduled = false;
			report(message);
		});
	};
}
