import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { ENV_HEAP_MB, getEnvValue } from "../config.js";
import { engineHeapRuntimeArgs } from "../modes/interactive-engine/engine-heap.ts";
import { INTERACTIVE_ENGINE_BOOTSTRAP_FLAG } from "./interactive-engine-bootstrap.ts";

const HEAP_RELAUNCHED_ENV = "ATOMIC_INTERNAL_HEAP_RELAUNCHED";
const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:=|$)/;

export interface TerminalState {
	readonly stdinIsTTY: boolean;
	readonly stdoutIsTTY: boolean;
}

/** Mirrors `resolveAppMode`: rpc, json and print modes, including print selected by piped input or output. */
export function isHeadlessInvocation(args: readonly string[], terminal: TerminalState): boolean {
	if (args.includes(INTERACTIVE_ENGINE_BOOTSTRAP_FLAG) || args.includes("--help") || args.includes("-h")) return false;
	const explicit = args.some(
		(arg, index) =>
			arg === "-p" || arg === "--print" || (arg === "--mode" && ["json", "rpc"].includes(args[index + 1] ?? "")),
	);
	return explicit || !terminal.stdinIsTTY || !terminal.stdoutIsTTY;
}

/**
 * Heap flags a headless run on Node should be relaunched with, or none. Interactive sessions size their engine
 * child instead, and a process that was already relaunched or started with an explicit heap size keeps its own.
 */
export function headlessHeapRelaunchArgs(args: readonly string[]): string[] {
	const terminal = { stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true };
	if (process.env[HEAP_RELAUNCHED_ENV] !== undefined) {
		delete process.env[HEAP_RELAUNCHED_ENV];
		return [];
	}
	if (!isHeadlessInvocation(args, terminal) || process.execArgv.some((arg) => HEAP_FLAG.test(arg))) return [];
	return engineHeapRuntimeArgs({
		runsOnNode: !("bun" in process.versions),
		totalMemoryBytes: totalmem(),
		constrainedMemoryBytes: process.constrainedMemory(),
		currentHeapLimitBytes: getHeapStatistics().heap_size_limit,
		nodeOptions: process.env.NODE_OPTIONS,
		execArgv: [],
		configuredHeapMb: getEnvValue(ENV_HEAP_MB),
	});
}

/** Runs this CLI again with the heap flags, passing through stdio, termination signals and the exit status. */
export function relaunchWithHeap(heapArgs: readonly string[], args: readonly string[]): void {
	const child = spawn(process.execPath, [...heapArgs, ...process.execArgv, process.argv[1]!, ...args], {
		stdio: "inherit",
		env: { ...process.env, [HEAP_RELAUNCHED_ENV]: "1" },
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
	child.on("error", (error) => {
		process.stderr.write(`Failed to start Atomic with a larger heap: ${error.message}\n`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}
