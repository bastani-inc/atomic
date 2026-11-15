import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { processStartToken } from "./process-start-token.ts";

/*
 * Every removal of another process's proper-lockfile lock goes through one mutex per lock (#5161): the takeover of a
 * lock whose holder is proven dead, and proper-lockfile's own removal of a stale lock. Each checks again, inside the
 * mutex, that the lock is still the one it judged, so a lock another process took since is never removed.
 */

/** How old a takeover mutex that names no owner must be before it is judged left by a killed process. */
export const TAKEOVER_MUTEX_STALE_MS = 10_000;

/** The directory that serializes takeovers of the lock at `lockPath`. */
export function takeoverMutexPath(lockPath: string): string {
	return `${lockPath}.takeover`;
}

/** The file inside a takeover mutex that names the process owning it. */
function mutexOwnerPath(mutexPath: string): string {
	return join(mutexPath, "owner");
}

/** A process, by its host, pid and start, as lock holders and takeover-mutex owners are named. */
export interface ProcessRecord {
	readonly host: string;
	readonly pid: number;
	readonly started?: string;
}

/** Whether `pid` is a live process on this host; one this process may not signal (EPERM) still exists. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether the process `record` names may still run, as session claims are judged: by its start when that can be read,
 * else by its pid, so a start that cannot be read never makes a running process another one. A process on another host
 * cannot be seen from here and may still run.
 */
export function processMayRun(record: ProcessRecord): boolean {
	if (record.host !== hostname()) return true;
	const started = record.started === undefined ? undefined : processStartToken(record.pid);
	if (started !== undefined) return started === record.started;
	return processAlive(record.pid);
}

/** Which directory `path` is now, or undefined when none is there or it is being removed. */
export function lockHolder(lockPath: string): string | undefined {
	try {
		const stats = statSync(lockPath);
		return `${stats.ino}:${stats.birthtimeMs}`;
	} catch {
		// None is there, or, on Windows, it is being removed and refuses to be stat'ed: it is changing hands.
		return undefined;
	}
}

interface MutexOwner extends ProcessRecord {
	/** Tells this taking of the mutex apart from any other by the same process. */
	readonly id: string;
}

function readMutexOwner(mutexPath: string): MutexOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(mutexOwnerPath(mutexPath), "utf8")) as Partial<MutexOwner>;
		if (typeof owner.id !== "string" || !Number.isSafeInteger(owner.pid)) return undefined;
		if (owner.started !== undefined && typeof owner.started !== "string") return undefined;
		return owner as MutexOwner;
	} catch {
		return undefined;
	}
}

/** A takeover mutex this process took. */
export interface TakeoverMutex {
	/** Whether this process still owns the mutex: checked just before a lock is moved or removed. */
	owned(): boolean;
	/** Gives the mutex up, when this process still owns it. */
	release(): void;
}

/**
 * Removes the takeover mutex at `mutexPath` when it is stale: its owner is proven dead, or it names no owner and is
 * {@link TAKEOVER_MUTEX_STALE_MS} old. It is moved aside first and removed only when it is still the mutex judged, so a
 * mutex another process took meanwhile is never removed; true when the mutex is gone.
 */
function removeStaleMutex(mutexPath: string): boolean {
	const judged = lockHolder(mutexPath);
	if (judged === undefined) return true;
	const owner = readMutexOwner(mutexPath);
	if (owner !== undefined) {
		if (processMayRun(owner)) return false;
	} else {
		const stats = statSync(mutexPath, { throwIfNoEntry: false });
		if (stats !== undefined && Date.now() - stats.mtimeMs < TAKEOVER_MUTEX_STALE_MS) return false;
	}
	const aside = `${mutexPath}.${randomUUID()}.dead`;
	try {
		renameSync(mutexPath, aside);
	} catch {
		return false;
	}
	// A mutex taken since it was judged is left aside: its owner no longer owns the mutex path, so it moves nothing.
	if (lockHolder(aside) !== judged || readMutexOwner(aside)?.id !== owner?.id) return false;
	rmSync(aside, { recursive: true, force: true });
	return true;
}

/**
 * Takes the takeover mutex of the lock at `lockPath`: creates its directory and names this process as its owner.
 * Undefined while another process holds it. A mutex whose owner is proven dead is removed, as is one that names no
 * owner once it is {@link TAKEOVER_MUTEX_STALE_MS} old; a live owner keeps its mutex however long it holds it.
 */
export function takeTakeoverMutex(lockPath: string): TakeoverMutex | undefined {
	const path = takeoverMutexPath(lockPath);
	const owner: MutexOwner = {
		host: hostname(),
		pid: process.pid,
		started: processStartToken(process.pid),
		id: randomUUID(),
	};
	const owned = () => readMutexOwner(path)?.id === owner.id;
	const take = (): TakeoverMutex | undefined => {
		try {
			mkdirSync(path);
		} catch {
			return undefined;
		}
		try {
			writeFileSync(mutexOwnerPath(path), JSON.stringify(owner));
		} catch {
			// A mutex that names no owner is not owned: this process moves nothing, and it goes stale by its age.
		}
		return {
			owned,
			release: () => {
				if (!owned()) return;
				try {
					rmSync(mutexOwnerPath(path), { force: true });
					rmdirSync(path);
				} catch {
					// Left behind, it names no owner and goes stale by its age.
				}
			},
		};
	};
	return take() ?? (removeStaleMutex(path) ? take() : undefined);
}

/**
 * Removes the lock directory at `lockPath` that proper-lockfile judged stale, older than `staleMs`, under the takeover
 * mutex (#5161). proper-lockfile checks a lock's age and then removes it, so two processes
 * that both saw a stale lock could each remove it, the second removing the lock the first had just taken. Inside the
 * mutex the directory is removed only while it is still stale, so a lock taken since is never removed. When the mutex
 * is held elsewhere or the lock is fresh again, nothing is removed and the next attempt finds the lock held.
 */
export function removeStaleLock(lockPath: string, staleMs: number): void {
	const mutex = takeTakeoverMutex(lockPath);
	if (mutex === undefined) return;
	try {
		const stats = statSync(lockPath, { throwIfNoEntry: false });
		if (stats === undefined || Date.now() - stats.mtimeMs <= staleMs || !mutex.owned()) return;
		rmdirSync(lockPath);
	} finally {
		mutex.release();
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
