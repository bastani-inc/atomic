import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES } from "../interactive-engine/protocol.ts";

export interface RpcClientProcessOptions {
	cliPath: string;
	cliArgs: string[];
	cwd?: string;
	env?: Record<string, string>;
	runtimeExecutable?: string;
	runtimeArgs?: string[];
	interactiveEngine: boolean;
}

const guardianFiles = new WeakMap<ChildProcess, string>();

export function spawnRpcClientProcess(options: RpcClientProcessOptions): ChildProcess {
	const guardianFile = options.interactiveEngine
		? join(tmpdir(), `atomic-engine-guardian-${process.pid}-${crypto.randomUUID()}`)
		: undefined;
	const child = spawn(
		options.runtimeExecutable ?? "bun",
		[...(options.runtimeArgs ?? []), ...(options.cliPath ? [options.cliPath] : []), ...options.cliArgs],
		{
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env,
				...(options.interactiveEngine ? {
					ATOMIC_INTERACTIVE_ENGINE_CHILD: "1",
					ATOMIC_INTERACTIVE_ENGINE_HOST_PID: String(process.pid),
					ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE: guardianFile!,
				} : {}),
			},
			detached: options.interactiveEngine && process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	if (guardianFile) guardianFiles.set(child, guardianFile);
	if (options.interactiveEngine && child.pid) {
		trackDetachedChildPid(child.pid);
		child.once("exit", () => untrackDetachedChildPid(child.pid!));
	}
	return child;
}

export async function terminateRpcClientProcess(child: ChildProcess, processTree: boolean): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
	child.once("exit", resolveExit);
	const guardianFile = guardianFiles.get(child);
	child.kill("SIGTERM");
	if (await Promise.race([exited.then(() => true), Bun.sleep(250).then(() => false)])) {
		if (guardianFile) await rm(guardianFile, { force: true });
		return;
	}
	if (processTree && guardianFile) {
		await Bun.write(guardianFile, "stop");
		if (await Promise.race([exited.then(() => true), Bun.sleep(500).then(() => false)])) {
			await rm(guardianFile, { force: true });
			return;
		}
	}
	if (processTree && child.pid) killProcessTree(child.pid);
	else child.kill("SIGKILL");
	if (!(await Promise.race([exited.then(() => true), Bun.sleep(250).then(() => false)]))) {
		throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
	}
	if (guardianFile) await rm(guardianFile, { force: true });
}

export function createInteractiveJsonlOptions(
	enabled: boolean,
	onDiagnostic: ((diagnostic: ActivityWatchdogDiagnostic) => void) | undefined,
): { maxBytesPerTurn?: number; maxFrameBytes?: number; onOversizedLine?: () => void } {
	if (!enabled) return {};
	return {
		maxBytesPerTurn: 256 * 1024,
		maxFrameBytes: INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
		onOversizedLine: () => onDiagnostic?.({
			activity: undefined,
			elapsedMs: 0,
			level: "unresponsive",
			message: "Interactive engine violated the 1 MiB protocol frame limit; pending requests were cancelled",
		}),
	};
}
