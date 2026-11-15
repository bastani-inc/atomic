import * as nodeFs from "node:fs";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/*
 * Every removal of another process's proper-lockfile lock goes through one mutex per lock (#5161): the takeover of a
 * lock whose holder is proven dead, and proper-lockfile's own removal of a stale lock. Each checks again, inside the
 * mutex, that the lock is still the one it judged, so a lock another process took since is never removed.
 */

/** How old a takeover mutex must be before it is judged left by a killed process and removed. */
export const TAKEOVER_MUTEX_STALE_MS = 10_000;

/** The directory that serializes takeovers of the lock at `lockPath`. */
export function takeoverMutexPath(lockPath: string): string {
	return `${lockPath}.takeover`;
}

/**
 * Takes the takeover mutex of the lock at `lockPath` by creating its directory; its release, or undefined while
 * another process holds it. One left by a killed process is removed once it is {@link TAKEOVER_MUTEX_STALE_MS} old.
 */
export function takeTakeoverMutex(lockPath: string): (() => void) | undefined {
	const path = takeoverMutexPath(lockPath);
	const release = () => {
		try {
			rmdirSync(path);
		} catch {
			// Removed as stale by another process; nothing is left to release.
		}
	};
	try {
		mkdirSync(path);
		return release;
	} catch {
		const stats = statSync(path, { throwIfNoEntry: false });
		if (stats === undefined || Date.now() - stats.mtimeMs < TAKEOVER_MUTEX_STALE_MS) return undefined;
	}
	release();
	try {
		mkdirSync(path);
		return release;
	} catch {
		return undefined;
	}
}

/**
 * Removes the lock directory at `lockPath` that proper-lockfile judged stale, older than `staleMs`, under the takeover
 * mutex (#5161). proper-lockfile checks a lock's age and then removes it, so two processes
 * that both saw a stale lock could each remove it, the second removing the lock the first had just taken. Inside the
 * mutex the directory is removed only while it is still stale, so a lock taken since is never removed. When the mutex
 * is held elsewhere or the lock is fresh again, nothing is removed and the next attempt finds the lock held.
 */
export function removeStaleLock(lockPath: string, staleMs: number): void {
	const release = takeTakeoverMutex(lockPath);
	if (release === undefined) return;
	try {
		const stats = statSync(lockPath, { throwIfNoEntry: false });
		if (stats === undefined || Date.now() - stats.mtimeMs <= staleMs) return;
		rmdirSync(lockPath);
	} finally {
		release();
	}
}

/** The file system proper-lockfile is given to take one lock, and {@link LockRemovalGuard.done} once it is taken. */
export interface LockRemovalGuard {
	readonly fs: typeof nodeFs;
	/** Ends the guard: from now on, removing the lock is this process releasing its own lock. */
	done(): void;
}

/**
 * A file system for proper-lockfile that, while the lock at `lockPath` is being taken, removes a stale lock only
 * through {@link removeStaleLock} with the caller's `staleMs`, the stale window proper-lockfile was given. Once
 * {@link LockRemovalGuard.done} is called, the lock's own release removes it directly.
 */
export function guardLockRemoval(lockPath: string, staleMs: number): LockRemovalGuard {
	const target = resolve(lockPath);
	let taking = true;
	const guarded = (path: nodeFs.PathLike) => taking && resolve(String(path)) === target;
	const rmdirSync = ((path: nodeFs.PathLike, options?: nodeFs.RmDirOptions) => {
		if (guarded(path)) removeStaleLock(target, staleMs);
		else nodeFs.rmdirSync(path, options);
	}) as typeof nodeFs.rmdirSync;
	const rmdir = ((path: nodeFs.PathLike, ...rest: unknown[]) => {
		const callback = rest.at(-1) as nodeFs.NoParamCallback;
		if (!guarded(path)) {
			nodeFs.rmdir(path, ...(rest as [nodeFs.NoParamCallback]));
			return;
		}
		try {
			removeStaleLock(target, staleMs);
		} catch (error) {
			callback(error as NodeJS.ErrnoException);
			return;
		}
		callback(null);
	}) as typeof nodeFs.rmdir;
	return {
		fs: { ...nodeFs, rmdir, rmdirSync },
		done: () => {
			taking = false;
		},
	};
}
