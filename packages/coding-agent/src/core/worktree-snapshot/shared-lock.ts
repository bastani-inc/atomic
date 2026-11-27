import { constants } from "node:fs";
import { access, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LockOptions } from "proper-lockfile";
import { clearLockHolderAsync, lockNamesLocalHolder, recordLockHolderAsync } from "../lock-holder.js";
import { removeLeftoverHolderFilesAsync, takeTakeoverMutexAsync } from "../lock-takeover.js";
import { lockShared, sharedClockNow } from "./shared-clock.ts";

/**
 * Takes a shared-clock directory lock and records its holder. Publishing an acquisition and both kinds of takeover
 * use the same mutex: an expired-lock remover can't unlink a new lock created after its last stat. Callers can use
 * `takeOverDeadHolderAsync` after `ELOCKED` to reclaim a lock with a dead local owner without waiting for its mtime.
 */
export async function lockSharedWithHolder(
	file: string,
	options: LockOptions & { readonly stale: number; readonly realpath: false },
): Promise<() => Promise<void>> {
	const lockPath = options.lockfilePath ?? `${resolve(file)}.lock`;
	const directory = dirname(lockPath);
	const mutex = await takeTakeoverMutexAsync(lockPath, 0);
	if (mutex === undefined) {
		// The directory-mutex fallback cannot distinguish contention from a read-only directory.
		await access(directory, constants.W_OK);
		throw Object.assign(new Error("Lock is changing hands"), { code: "ELOCKED" });
	}
	let compromised = false;
	let unlock: () => Promise<void>;
	try {
		unlock = await lockShared(
			file,
			{
				...options,
				onCompromised: (error) => {
					compromised = true;
					options.onCompromised?.(error);
				},
			},
			async (candidate) => {
				// A live local holder keeps its lock even if it was paused longer than the heartbeat timeout.
				if (await lockNamesLocalHolder(candidate)) return;
				const now = await sharedClockNow(directory);
				try {
					if (now - (await stat(candidate)).mtimeMs <= options.stale || !(await mutex.owned())) return;
					await rmdir(candidate);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await removeLeftoverHolderFilesAsync(candidate);
			},
		);
		await recordLockHolderAsync(lockPath);
	} finally {
		await mutex.release();
	}
	return async () => {
		const releaseMutex = await takeTakeoverMutexAsync(lockPath);
		try {
			await unlock();
		} finally {
			// If the mutex is busy, leave the sidecar: it won't match the next lock directory.
			if (releaseMutex !== undefined) {
				try {
					if (!compromised) await clearLockHolderAsync(lockPath);
					else if (await lockNamesLocalHolder(lockPath, process.pid)) {
						// A failed heartbeat can make proper-lockfile forget a lock that is still ours on disk.
						await rmdir(lockPath).catch(() => {});
						await clearLockHolderAsync(lockPath);
					}
				} finally {
					await releaseMutex.release();
				}
			}
		}
	};
}
