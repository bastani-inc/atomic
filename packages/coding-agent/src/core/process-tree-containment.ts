import { createModuleRequire } from "../utils/module-require.ts";

export interface ProcessTreeContainment {
	terminate(): boolean;
	activeProcesses(): number;
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
