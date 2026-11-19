import { createRequire } from "node:module";
import type * as native from "@bastani/atomic-natives";

let bindings: Partial<typeof native> | null | undefined;
function windowsBindings(): Partial<typeof native> | null {
	if (bindings === undefined) {
		bindings = null;
		// The compiled launcher ships the binding next to the executable, not at the bundled module's source URL.
		for (const anchor of [import.meta.url, process.execPath]) {
			try {
				bindings = createRequire(anchor)("@bastani/atomic-natives") as Partial<typeof native>;
				break;
			} catch {}
		}
	}
	return bindings;
}

/** Open a new file without sharing deletion. A clock probes with its granted rights; a record reserves delete-on-close. */
export async function openWindowsTemporary(
	path: string,
	kind: "clock" | "record",
): Promise<{ close(): Promise<unknown> } | undefined> {
	const create = windowsBindings()?.openWindowsTemporaryFile;
	try {
		return (await create?.(path, kind === "clock")) ?? undefined;
	} catch (error) {
		if (error instanceof Error && error.message === "EEXIST") throw Object.assign(error, { code: "EEXIST" });
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
		return undefined;
	}
}

/** Judge and delete an old probe through the same file handle, even if a different file now uses its old name. */
export function sweepWindowsProbe(path: string, before: number): Promise<unknown> | undefined {
	return windowsBindings()?.removeWindowsFileOlderThan?.(path, before);
}
