import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "../../utils/shell.ts";
import type { ActivityWatchdogDiagnostic } from "../interactive-engine/activity-watchdog.ts";
import { INTERACTIVE_ENGINE_MAX_FRAME_CHARS } from "../interactive-engine/protocol.ts";

export interface RpcClientProcessOptions {
	cliPath: string;
	cliArgs: string[];
	cwd?: string;
	env?: Record<string, string>;
	runtimeExecutable?: string;
	runtimeArgs?: string[];
	interactiveEngine: boolean;
}

export function spawnRpcClientProcess(options: RpcClientProcessOptions): ChildProcess {
	return spawn(
		options.runtimeExecutable ?? "node",
		[...(options.runtimeArgs ?? []), ...(options.cliPath ? [options.cliPath] : []), ...options.cliArgs],
		{
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env,
				...(options.interactiveEngine ? { ATOMIC_INTERACTIVE_ENGINE_CHILD: "1" } : {}),
			},
			detached: options.interactiveEngine && process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
}

export async function terminateRpcClientProcess(child: ChildProcess, processTree: boolean): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let resolveExit!: () => void;
	const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
	child.once("exit", resolveExit);
	child.kill("SIGTERM");
	if (await Promise.race([exited.then(() => true), Bun.sleep(1_000).then(() => false)])) return;
	if (processTree && child.pid) killProcessTree(child.pid);
	else child.kill("SIGKILL");
	if (!(await Promise.race([exited.then(() => true), Bun.sleep(250).then(() => false)]))) {
		throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
	}
}

export function createInteractiveJsonlOptions(
	enabled: boolean,
	onDiagnostic: ((diagnostic: ActivityWatchdogDiagnostic) => void) | undefined,
): { maxLinesPerTurn?: number; maxLineChars?: number; onOversizedLine?: () => void } {
	if (!enabled) return {};
	return {
		maxLinesPerTurn: 64,
		maxLineChars: INTERACTIVE_ENGINE_MAX_FRAME_CHARS,
		onOversizedLine: () => onDiagnostic?.({
			activity: undefined,
			elapsedMs: 0,
			level: "blocking",
			message: "Interactive engine discarded a protocol frame larger than 1 MiB; the TUI remains responsive",
		}),
	};
}
