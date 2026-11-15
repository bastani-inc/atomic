import { renameSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";

/**
 * How often a rename that Windows refuses for a moment is tried in all, 20 ms apart: about two seconds. Another
 * process's open handle (an antivirus scan, the indexer, a handle still closing) refuses it with EPERM, EACCES or EBUSY.
 */
export const RENAME_ATTEMPTS = 100;
const RENAME_RETRY_MS = 20;
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Whether a rename that failed with `error` on `attempt` is tried again. */
function retriesRename(error: unknown, attempt: number, platform: NodeJS.Platform): boolean {
	const code = (error as NodeJS.ErrnoException).code ?? "";
	return platform === "win32" && attempt < RENAME_ATTEMPTS && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Rename `from` to `to`. On Windows, a rename another process's handle refuses (EPERM, EACCES, EBUSY) is tried again,
 * {@link RENAME_ATTEMPTS} times in all; elsewhere, and for any other error, it throws at once.
 */
export function renameReplacing(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
	rename: (from: string, to: string) => void = renameSync,
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			if (!retriesRename(error, attempt, platform)) throw error;
			// Callers stay synchronous; block this thread without spinning the CPU.
			Atomics.wait(sleeper, 0, 0, RENAME_RETRY_MS);
		}
	}
}

/** {@link renameReplacing} for asynchronous callers. */
export async function renameReplacingAsync(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
	rename: (from: string, to: string) => Promise<void> = renameAsync,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (!retriesRename(error, attempt, platform)) throw error;
			await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
		}
	}
}
