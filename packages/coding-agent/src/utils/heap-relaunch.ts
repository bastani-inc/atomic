import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { ENV_HEAP_MB, getEnvValue } from "../config.js";
import { engineHeapRuntimeArgs } from "../modes/interactive-engine/engine-heap.ts";
import { INTERACTIVE_ENGINE_BOOTSTRAP_FLAG } from "./interactive-engine-bootstrap.ts";

const HEAP_RELAUNCHED_ENV = "ATOMIC_INTERNAL_HEAP_RELAUNCHED";
const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:=|$)/;

export function isHeadlessInvocation(args: readonly string[]): boolean {
	if (args.includes(INTERACTIVE_ENGINE_BOOTSTRAP_FLAG)) return false;
	return args.some(
		(arg, index) =>
			arg === "-p" || arg === "--print" || (arg === "--mode" && ["json", "rpc"].includes(args[index + 1] ?? "")),
	);
}

/**
 * Heap flags a headless run on Node should be relaunched with, or none. Interactive sessions size their engine
 * child instead, and a process that was already relaunched or started with an explicit heap size keeps its own.
 */
export function headlessHeapRelaunchArgs(args: readonly string[]): string[] {
	if (process.env[HEAP_RELAUNCHED_ENV] !== undefined) {
		delete process.env[HEAP_RELAUNCHED_ENV];
		return [];
	}
	if (!isHeadlessInvocation(args) || process.execArgv.some((arg) => HEAP_FLAG.test(arg))) return [];
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
	// The terminal delivers Ctrl+C to the whole process group, so the child already receives SIGINT.
	process.on("SIGINT", () => {});
	for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
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
