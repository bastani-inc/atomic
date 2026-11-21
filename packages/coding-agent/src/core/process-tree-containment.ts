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

type ContainProcessTree = (pid: number, options?: ContainmentOptions) => ProcessTreeContainment | null;

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

export function containProcessTree(pid: number, options?: ContainmentOptions): ProcessTreeContainment | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		return containFunction()?.(pid, options) ?? undefined;
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
