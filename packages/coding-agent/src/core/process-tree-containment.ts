import { setTimeout as sleep } from "node:timers/promises";
import { createModuleRequire } from "../utils/module-require.js";

export interface ProcessTreeContainment {
	terminate(): boolean;
	activeProcesses(): number;
	release(): boolean;
	close(): void;
}

type ContainProcessTree = (pid: number) => ProcessTreeContainment | null;

let nativeContain: ContainProcessTree | null | undefined;

function containFunction(): ContainProcessTree | null {
	if (nativeContain === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				containProcessTree?: ContainProcessTree;
			};
			nativeContain = binding.containProcessTree ?? null;
		} catch {
			nativeContain = null;
		}
	}
	return nativeContain;
}

export function containProcessTree(pid: number): ProcessTreeContainment | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		return containFunction()?.(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

type TerminateProcessDescendants = (pid: number) => number;

let nativeTerminateDescendants: TerminateProcessDescendants | null | undefined;

/**
 * On Windows, ends the processes that child process `pid` started, and those they started, each through a handle of its
 * own: a process is taken only once it is open, and only when it is still the child of its parent and started after it
 * (by the kernel's order of process starts, not by a clock), so a process given an id that one of them had is never
 * ended. Nothing ends once `pid` itself has exited, checked again right before the first of them ends. Returns how many
 * it ended, or `undefined` off Windows and without the native module. `pid` must be a child whose exit this process has
 * not seen yet, so that it still holds its handle and the id names it. A process whose parent already ended is not
 * found.
 */
export function terminateProcessDescendants(pid: number): number | undefined {
	if (process.platform !== "win32") return undefined;
	if (nativeTerminateDescendants === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				terminateProcessDescendants?: TerminateProcessDescendants;
			};
			nativeTerminateDescendants = binding.terminateProcessDescendants ?? null;
		} catch {
			nativeTerminateDescendants = null;
		}
	}
	try {
		return nativeTerminateDescendants?.(pid);
	} catch {
		return undefined;
	}
}

export async function processTreeEnded(tree: ProcessTreeContainment, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (tree.activeProcesses() === 0) return;
		} catch {
			return;
		}
		if (Date.now() >= deadline) return;
		await sleep(5);
	}
}
