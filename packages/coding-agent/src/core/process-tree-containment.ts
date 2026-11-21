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

/** The processes below a running process, each held through a handle of its own. */
export interface HeldProcessDescendants {
	readonly count: number;
	/** Ends every process it holds and lets go of them; returns how many it ended. */
	terminate(): number;
	/** Lets go of the processes it holds without ending them. */
	release(): void;
}

type HoldProcessDescendants = (pid: number) => HeldProcessDescendants | null;

let nativeHoldDescendants: HoldProcessDescendants | null | undefined;

/**
 * On Windows, holds the processes that child process `pid` started, and those they started, each through a handle of
 * its own: a process is taken only once it is open, and only when it is still the child of its parent and started after
 * it (by the kernel's order of process starts, not by a clock), so a process given an id that one of them had is never
 * held. `undefined` once `pid` has exited, off Windows, and without the native module. `pid` must be a child whose exit
 * this process has not seen yet, so that it still holds its handle and the id names it. A process whose parent already
 * ended is not found.
 */
export function holdProcessDescendants(pid: number): HeldProcessDescendants | undefined {
	if (process.platform !== "win32") return undefined;
	if (nativeHoldDescendants === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				holdProcessDescendants?: HoldProcessDescendants;
			};
			nativeHoldDescendants = binding.holdProcessDescendants ?? null;
		} catch {
			nativeHoldDescendants = null;
		}
	}
	try {
		return nativeHoldDescendants?.(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ends a command and then the processes below it that `held` holds, only if `killCommand` ended the command: a command
 * that waits on a process it started, as `cmd /c` does, would otherwise exit on its own once that process ends, and
 * report its own status rather than having been ended. A command that already exited leaves what it started running.
 */
export function endCommandThenHeld(held: HeldProcessDescendants | undefined, killCommand: () => boolean): void {
	try {
		if (killCommand()) held?.terminate();
	} finally {
		held?.release();
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
