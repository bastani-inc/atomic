import { type ChildProcess, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushPersistentCompileCache } from "../../utils/compile-cache.ts";
import {
	INTERACTIVE_ENGINE_BOOTSTRAP_FLAG,
	type InteractiveEngineBootstrapHandle,
	removeOwnedInteractiveEngineBootstrap,
	writeInteractiveEngineBootstrap,
} from "../../utils/interactive-engine-bootstrap.ts";
import { scrubInteractiveEngineEnv } from "../../utils/interactive-engine-env.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { sleep } from "../../utils/sleep.ts";

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
}

const guardianFiles = new WeakMap<ChildProcess, string>();
const bootstrapHandles = new WeakMap<ChildProcess, InteractiveEngineBootstrapHandle>();

export function spawnRpcClientProcess(options: RpcClientProcessOptions): ChildProcess {
	const guardianFile = options.interactiveEngine
		? join(tmpdir(), `atomic-engine-guardian-${process.pid}-${crypto.randomUUID()}`)
		: undefined;
	// The engine's startup metadata travels in a 0600 file rather than the
	// environment: a Bun child spawned without an explicit `env` inherits the
	// runtime's launch-time environment, so anything placed here would remain
	// reachable by every descendant of the engine no matter what the engine
	// deletes from its own `process.env` afterwards.
	const bootstrap = options.interactiveEngine
		? writeInteractiveEngineBootstrap({
				hostPid: process.pid,
				guardFile: guardianFile!,
				...(options.interactiveEngineApiKey ? { apiKey: options.interactiveEngineApiKey } : {}),
			})
		: undefined;
	if (options.interactiveEngine) flushPersistentCompileCache();
	const cliArgs = bootstrap
		? [...options.cliArgs, INTERACTIVE_ENGINE_BOOTSTRAP_FLAG, bootstrap.path]
		: options.cliArgs;
	let child: ChildProcess;
	try {
		child = spawn(
			options.runtimeExecutable ?? "bun",
			[...(options.runtimeArgs ?? []), ...(options.cliPath ? [options.cliPath] : []), ...cliArgs],
			{
				cwd: options.cwd,
				env: scrubInteractiveEngineEnv({ ...process.env, ...options.env }),
				detached: options.interactiveEngine && process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	} catch (error) {
		removeOwnedInteractiveEngineBootstrap(bootstrap);
		throw error;
	}
	if (guardianFile) guardianFiles.set(child, guardianFile);
	if (bootstrap) {
		bootstrapHandles.set(child, bootstrap);
		// The child unlinks the record after reading it; this handle-scoped cleanup
		// removes the directory this process created, and only that directory.
		child.once("error", () => removeOwnedInteractiveEngineBootstrap(bootstrap));
		child.once("exit", () => removeOwnedInteractiveEngineBootstrap(bootstrap));
	}
	if (options.interactiveEngine && child.pid) {
		trackDetachedChildPid(child.pid);
		child.once("exit", () => untrackDetachedChildPid(child.pid!));
	}
	return child;
}

export async function terminateRpcClientProcess(child: ChildProcess, processTree: boolean): Promise<void> {
	removeOwnedInteractiveEngineBootstrap(bootstrapHandles.get(child));
	if (child.exitCode !== null || child.signalCode !== null) return;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});
	child.once("exit", resolveExit);
	const guardianFile = guardianFiles.get(child);
	child.kill("SIGTERM");
	if (await Promise.race([exited.then(() => true), sleep(250).then(() => false)])) {
		if (guardianFile) await rm(guardianFile, { force: true });
		return;
	}
	if (processTree && guardianFile) {
		await writeFile(guardianFile, "stop");
		if (await Promise.race([exited.then(() => true), sleep(500).then(() => false)])) {
			await rm(guardianFile, { force: true });
			return;
		}
	}
	if (processTree && child.pid) killProcessTree(child.pid);
	else child.kill("SIGKILL");
	if (!(await Promise.race([exited.then(() => true), sleep(250).then(() => false)]))) {
		throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
	}
	if (guardianFile) await rm(guardianFile, { force: true });
}

export function createInteractiveJsonlOptions(enabled: boolean): { maxBytesPerTurn?: number } {
	return enabled ? { maxBytesPerTurn: 256 * 1024 } : {};
}

/**
 * CLI args for a replacement engine child: drop whatever session flag the
 * previous generation carried and bind the replacement to `sessionFile`, so a
 * restart resumes the same conversation instead of starting a fresh one.
 */
export function restartCliArgs(args: readonly string[] | undefined, sessionFile: string | undefined): string[] {
	const result: string[] = [];
	for (let index = 0; index < (args?.length ?? 0); index += 1) {
		const value = args![index]!;
		if (value === "--no-session") continue;
		if (value === "--session") {
			index += 1;
			continue;
		}
		result.push(value);
	}
	result.push(sessionFile ? "--session" : "--no-session");
	if (sessionFile) result.push(sessionFile);
	return result;
}

const MAX_STDERR_BYTES = 256 * 1024;

/** Keep only the tail of a child's stderr, so a noisy child cannot grow the host. */
export function appendBoundedStderr(existing: string, chunk: string): string {
	const next = existing + chunk;
	if (Buffer.byteLength(next, "utf8") <= MAX_STDERR_BYTES) return next;
	return `${Buffer.from(next).subarray(-MAX_STDERR_BYTES).toString("utf8")}\n[stderr truncated]`;
}
