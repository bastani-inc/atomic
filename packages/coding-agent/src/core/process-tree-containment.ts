import { setTimeout as sleep } from "node:timers/promises";
import { createModuleRequire } from "../utils/module-require.js";

export interface ProcessTreeContainment {
	terminate(): boolean;
	activeProcesses(): number;
	release(): boolean;
	close(): void;
}

type ContainProcessTree = (pid: number) => ProcessTreeContainment | null;

/** Whether the loaded native addon was built for Windows (its Windows process-tree calls exist only there). */
const NATIVE_WINDOWS_HOST = process.platform === "win32";

let nativeContain: ContainProcessTree | null | undefined;
let nativeContainAllowingBreakaway: ContainProcessTree | null | undefined;

function containFunction(): ContainProcessTree | null {
	if (!NATIVE_WINDOWS_HOST) return null;
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

function containAllowingBreakawayFunction(): ContainProcessTree | null {
	if (!NATIVE_WINDOWS_HOST) return null;
	if (nativeContainAllowingBreakaway === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				containProcessTreeAllowingBreakaway?: ContainProcessTree;
			};
			nativeContainAllowingBreakaway = binding.containProcessTreeAllowingBreakaway ?? null;
		} catch {
			nativeContainAllowingBreakaway = null;
		}
	}
	return nativeContainAllowingBreakaway;
}

export function containProcessTree(pid: number): ProcessTreeContainment | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		return containFunction()?.(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Like {@link containProcessTree}, but sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK` so descendants that explicitly request
 * `CREATE_BREAKAWAY_FROM_JOB` can start and outlive the command, while non-breakaway descendants remain contained.
 */
export function containProcessTreeAllowingBreakaway(pid: number): ProcessTreeContainment | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		return containAllowingBreakawayFunction()?.(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/** A running process and the processes below it, each held through a handle of its own. */
export interface HeldProcessDescendants {
	/** How many processes below it it holds. */
	readonly count: number;
	/**
	 * Ends the process they are below, and then them, only if it ended that process: one that exited by itself first
	 * leaves them running. Lets go of all of them; returns whether it ended that process.
	 */
	endAll(): boolean;
	/**
	 * Ends only the held descendants while keeping the root handle open. Used when the root is the current process
	 * itself so descendants end before the current process terminates.
	 */
	endDescendants?(): number;
	/** Lets go of the processes it holds without ending them. */
	release(): void;
}

type HoldProcessDescendants = (pid: number) => HeldProcessDescendants | null;

let nativeHoldDescendants: HoldProcessDescendants | null | undefined;

function holdDescendantsFunction(): HoldProcessDescendants | null {
	if (!NATIVE_WINDOWS_HOST) return null;
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
	return nativeHoldDescendants;
}

/**
 * Outcome of trying to hold a running Windows process and its descendants through native handles:
 * - `"held"`: the running root and its sequence-number-verified descendants are held and ready for `endAll()`.
 * - `"absent"`: the native addon ran and found the process already exited, gone, or unopenable (do not fall back to
 *   bare-PID `taskkill`).
 * - `"unavailable"`: off Windows, or the native addon lacks `holdProcessDescendants`.
 */
export type ProcessDescendantsHold =
	| { readonly kind: "held"; readonly held: HeldProcessDescendants }
	| { readonly kind: "absent" }
	| { readonly kind: "unavailable" };

export function hasNativeProcessHold(): boolean {
	return process.platform === "win32" && holdDescendantsFunction() !== null;
}

export function holdProcessDescendantsResult(pid: number): ProcessDescendantsHold {
	if (process.platform !== "win32") return { kind: "unavailable" };
	const hold = holdDescendantsFunction();
	if (hold === null) return { kind: "unavailable" };
	try {
		const held = hold(pid);
		return held === null ? { kind: "absent" } : { kind: "held", held };
	} catch {
		return { kind: "unavailable" };
	}
}

/**
 * On Windows, holds running child process `pid` and the processes it started, and those they started, each through a
 * handle of its own: a process is taken only once it is open, and only when it is still the child of its parent and
 * started after it (by the kernel's order of process starts, not by a clock), so a process given an id that one of them
 * had is never held. `undefined` once `pid` has exited, off Windows, and without the native module. `pid` must be a
 * child whose exit this process has not seen yet, so that it still holds its handle and the id names it. A process
 * whose parent already ended is not found.
 */
export function holdProcessDescendants(pid: number): HeldProcessDescendants | undefined {
	const result = holdProcessDescendantsResult(pid);
	return result.kind === "held" ? result.held : undefined;
}

/** A running child process that the host-death guardian ends, with what it started in its group, if this process dies. */
export interface HostDeathWatch {
	/** Stops the watch, once the process exited: what it left running keeps running. */
	release(): void;
}

type WatchProcessUntilHostDies = (pid: number) => HostDeathWatch | null;

let nativeWatchUntilHostDies: WatchProcessUntilHostDies | null | undefined;

function watchUntilHostDiesFunction(): WatchProcessUntilHostDies | null {
	if (NATIVE_WINDOWS_HOST) return null;
	if (nativeWatchUntilHostDies === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				watchProcessUntilHostDies?: WatchProcessUntilHostDies;
			};
			nativeWatchUntilHostDies = binding.watchProcessUntilHostDies ?? null;
		} catch {
			nativeWatchUntilHostDies = null;
		}
	}
	return nativeWatchUntilHostDies;
}

/** Whether {@link watchProcessUntilHostDies} can watch a process here: on Linux and macOS, with the native module. */
export function canWatchProcessUntilHostDies(): boolean {
	return watchUntilHostDiesFunction() !== null;
}

/**
 * On Linux and macOS, has the native host-death guardian, a process of its own, SIGKILL running child process `pid`
 * and the processes below it in its process group when this process dies, however it dies (`kill -9` included), until
 * `release()`. A PID that by then names another process is not touched, and a program that left the group is not
 * followed. `pid` must be a child whose exit this process has not seen yet. `undefined` on Windows, without the native
 * module, and when no guardian can run.
 */
export function watchProcessUntilHostDies(pid: number): HostDeathWatch | undefined {
	try {
		return watchUntilHostDiesFunction()?.(pid) ?? undefined;
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
