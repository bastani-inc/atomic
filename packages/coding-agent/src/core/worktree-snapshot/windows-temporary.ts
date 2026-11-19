import type * as native from "@bastani/atomic-natives";

// The native package advertises these operations when another caller loads it. Looking up the package here
// would charge the first lock for loading it, or even ask Bun to install it in the middle of a clock sample.
const loadedKey = Symbol.for("@bastani/atomic/windows-temporary@1");
const host = process as NodeJS.Process & { [loadedKey]?: typeof native };

/** Open a new file without sharing deletion. A clock probes with its granted rights; a record reserves write and delete access. */
export function openWindowsTemporary(path: string, kind: "clock" | "record") {
	return host[loadedKey]?.openWindowsTemporaryFile(path, kind === "clock").catch((error: unknown) => {
		if (error instanceof Error && error.message === "EEXIST") throw Object.assign(error, { code: "EEXIST" });
		throw error;
	});
}

/** Judge and delete an old probe through the same file handle, even if a different file now uses its old name. */
export function sweepWindowsProbe(path: string, before: number): Promise<unknown> | undefined {
	return host[loadedKey]?.removeWindowsFileOlderThan(path, before);
}
