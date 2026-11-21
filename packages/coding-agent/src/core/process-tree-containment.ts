import { setTimeout as sleep } from "node:timers/promises";
import { createModuleRequire } from "../utils/module-require.js";

export interface ProcessTreeContainment {
	terminate(): boolean;
	activeProcesses(): number;
	release(): boolean;
	close(): void;
}

/** How a process tree is contained. */
export interface ContainmentOptions {
	/** Lets a process in the tree start a child outside it, as `CREATE_BREAKAWAY_FROM_JOB` asks; such a start fails otherwise. */
	readonly allowBreakaway?: boolean;
}

type ContainProcessTree = (pid: number) => ProcessTreeContainment | null;

/** The native module's containment functions, as far as the loaded version has them. */
export interface NativeContainment {
	readonly containProcessTree?: ContainProcessTree;
	readonly containProcessTreeAllowingBreakaway?: ContainProcessTree;
}

let nativeBinding: NativeContainment | null | undefined;

function containmentBinding(): NativeContainment | null {
	if (nativeBinding === undefined) {
		try {
			nativeBinding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as NativeContainment;
		} catch {
			nativeBinding = null;
		}
	}
	return nativeBinding;
}

/**
 * The native function that contains a tree as `options` ask. A native module without one that lets a process leave the
 * job gives none for that, rather than a job that would make such a start fail.
 */
export function containmentFunction(
	binding: NativeContainment | null,
	options?: ContainmentOptions,
): ContainProcessTree | undefined {
	return options?.allowBreakaway === true ? binding?.containProcessTreeAllowingBreakaway : binding?.containProcessTree;
}

export function containProcessTree(pid: number, options?: ContainmentOptions): ProcessTreeContainment | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		return containmentFunction(containmentBinding(), options)?.(pid) ?? undefined;
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
