import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type * as native from "@bastani/atomic-natives";
import { createModuleRequire } from "../../utils/module-require.js";

let bindings: Partial<typeof native> | null | undefined;
function windowsBindings(): Partial<typeof native> | null {
	if (bindings === undefined) {
		try {
			bindings = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as Partial<typeof native>;
		} catch {
			bindings = null;
		}
	}
	return bindings;
}

/** An exclusive Windows file with deletion reserved at creation. Its name cannot be replaced while we use it. */
export async function openWindowsTemporary(path: string): Promise<{ close(): Promise<unknown> } | undefined> {
	const create = windowsBindings()?.openWindowsTemporaryFile;
	try {
		if (create) return (await create(path)) ?? undefined;
		if (process.versions.bun) return undefined;
		// The Windows CRT's _O_TEMPORARY flag is recognized by Node's filesystem implementation.
		return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | 0x40);
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
