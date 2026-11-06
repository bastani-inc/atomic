import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getErrnoCode } from "../../tools/errno.ts";
import {
	acquireProtectedPaths,
	ensureTempDir,
	getTempRootDir,
	SESSION_TEMP_FILE_MODE,
} from "../../tools/session-temp-dir.ts";
import { SessionSpillError } from "../errors.js";
import type { SessionHistoryFiles } from "./memory-session-store.js";

/** Directories of stores still open in this process, removed at exit. */
const liveDirectories = new Set<string>();
let exitCleanupInstalled = false;

function removeDirectoriesAtExit(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.once("exit", () => {
		for (const directory of liveDirectories) {
			try {
				rmSync(directory, { recursive: true });
			} catch {
				// Nothing can report it while the process exits; Atomic's temp sweep removes what is left.
			}
		}
	});
}

/** Writes `data` at `position` of the file at `path`, creating the file, or emptying it, when `position` is 0. */
async function writeAt(path: string, data: Uint8Array, position: number): Promise<void> {
	const handle = await open(path, position === 0 ? "w" : "r+", SESSION_TEMP_FILE_MODE);
	let failure: unknown;
	try {
		for (let written = 0; written < data.byteLength; ) {
			const { bytesWritten } = await handle.write(data, written, data.byteLength - written, position + written);
			written += bytesWritten;
		}
	} catch (error) {
		failure = error;
	}
	try {
		await handle.close();
	} catch (closeFailure) {
		if (failure === undefined) throw closeFailure;
		if (failure instanceof Error) Object.defineProperty(failure, "cleanupCause", { value: closeFailure });
	}
	if (failure !== undefined) throw failure;
}

/**
 * Released sessions' history in files under Atomic's temp directory (`$TMPDIR/atomic-<uid>/`): one owner-only
 * directory per store, kept from the temp sweep while the store is open and removed at exit if no store closed it
 * first, with one owner-only file per session. On a tmpfs `/tmp` these files still take memory; point `TMPDIR` at a
 * disk-backed directory.
 */
export const tempSessionHistoryFiles: SessionHistoryFiles = {
	createDirectory() {
		const path = join(getTempRootDir(), `memory-sessions-${process.pid}-${randomBytes(6).toString("hex")}`);
		try {
			ensureTempDir(path);
		} catch (cause) {
			return new SessionSpillError("spill-dir-refused", { directory: path, errno: getErrnoCode(cause) }, { cause });
		}
		const lease = acquireProtectedPaths([path]);
		liveDirectories.add(path);
		removeDirectoriesAtExit();
		const fileAt = (file: number) => join(path, String(file));
		return {
			path,
			write: (file, data, position) => writeAt(fileAt(file), data, position),
			read: (file) => readFile(fileAt(file)),
			async removeFile(file) {
				await rm(fileAt(file), { force: true });
			},
			async remove() {
				lease.release();
				liveDirectories.delete(path);
				await rm(path, { recursive: true, force: true });
			},
		};
	},
	report(degradation) {
		process.emitWarning(degradation);
	},
};
