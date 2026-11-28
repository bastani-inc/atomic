import { constants } from "node:fs";
import { access, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LockOptions } from "proper-lockfile";
import { asyncScope } from "../async-scope.ts";
import { clearLockHolderAsync, lockNamesLocalHolder, recordLockHolderAsync } from "../lock-holder.js";
import { lockHolderAsync, removeLeftoverHolderFilesAsync, takeTakeoverMutexAsync } from "../lock-takeover.js";
import { lockShared, sharedClockNow } from "./shared-clock.ts";

const worktreeLockProgress = asyncScope<(message: string) => void>();

/** Sends lock waits to the resume UI rather than writing over it on stderr. */
export function withWorktreeLockProgress<T>(onProgress: ((message: string) => void) | undefined, run: () => T): T {
	return onProgress === undefined ? run() : worktreeLockProgress.run(onProgress, run);
}

export function reportWorktreeLockProgress(message: string): void {
	(worktreeLockProgress.getStore() ?? process.emitWarning)(message);
}

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
	let published = false;
	let generation: string | undefined;
	let unlock: () => Promise<void>;
	const releaseDirectory = async (candidate: string) => {
		// Cleanup after an acquisition error is already under the mutex. Once acquired, even a late
		// release (before the heartbeat noticed an older build's takeover) must not remove its successor.
		if (published && (generation === undefined || (await lockHolderAsync(candidate)) !== generation)) return;
		await rmdir(candidate);
	};
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
			{
				stale: async (candidate) => {
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
				release: releaseDirectory,
			},
		);
		generation = await recordLockHolderAsync(lockPath);
		published = true;
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
					// A failed heartbeat can make proper-lockfile forget a lock that is still ours on disk.
					if (compromised) await releaseDirectory(lockPath).catch(() => {});
					if (generation !== undefined) await clearLockHolderAsync(lockPath, generation);
				} finally {
					await releaseMutex.release();
				}
			}
		}
	};
}
