import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { lockHolder } from "./lock-wait.ts";
import { processStartToken } from "./process-start-token.ts";
import { renameReplacing } from "./rename-retry.ts";

/**
 * Who holds a proper-lockfile lock, kept beside its lock directory (#5161): the host, the pid and when that process
 * started, and which lock directory it took. A lock whose holder is proven dead by these is taken over at once, rather
 * than after proper-lockfile's stale window; one whose holder cannot be judged waits for that window as before.
 */
interface LockHolderRecord {
	readonly host: string;
	readonly pid: number;
	readonly started?: string;
	/** The lock directory this holder created, as {@link lockHolder} names it. */
	readonly lock: string;
}

/** The file beside lock directory `lockPath` that names its holder. */
export function lockHolderPath(lockPath: string): string {
	return `${lockPath}.holder`;
}

/**
 * Names this process as the holder of the lock directory at `lockPath`, which it has just taken. Best effort: a lock
 * whose holder is not named is only taken over once it is stale.
 */
export function recordLockHolder(lockPath: string): void {
	const lock = lockHolder(lockPath);
	if (lock === undefined) return;
	const record: LockHolderRecord = {
		host: hostname(),
		pid: process.pid,
		started: processStartToken(process.pid),
		lock,
	};
	const path = lockHolderPath(lockPath);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(record));
		renameReplacing(temporary, path);
	} catch {
		rmSync(temporary, { force: true });
	}
}

/** Forgets this process as the holder of the lock at `lockPath`, before it releases the lock. */
export function clearLockHolder(lockPath: string): void {
	try {
		rmSync(lockHolderPath(lockPath), { force: true });
	} catch {
		// A holder record left behind names a lock directory that no longer exists, so it is never acted on.
	}
}

function readHolderRecord(lockPath: string): LockHolderRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(lockHolderPath(lockPath), "utf8")) as Partial<LockHolderRecord>;
		// A host or lock that is not a string never matches this host or a lock directory, so only these are checked.
		if (!Number.isSafeInteger(record.pid)) return undefined;
		if (record.started !== undefined && typeof record.started !== "string") return undefined;
		return record as LockHolderRecord;
	} catch {
		return undefined;
	}
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

/** Whether the holder `record` names may still run: by its pid and start, as session claims are judged. */
function holderMayRun(record: LockHolderRecord): boolean {
	// Another host's processes cannot be seen from here.
	if (record.host !== hostname()) return true;
	const started = record.started === undefined ? undefined : processStartToken(record.pid);
	if (started !== undefined) return started === record.started;
	return processAlive(record.pid);
}

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
function takeTakeoverMutex(lockPath: string): (() => void) | undefined {
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
 * Removes the lock directory at `lockPath` when its holder is proven dead, so the next attempt to take it follows at
 * once; true when it did. Takeovers are serialized by a mutex of their own, and inside it the holder record and the
 * lock directory are checked again just before the directory is moved aside, so a lock another process took after the
 * dead holder's is never moved. A directory that, once moved, turns out not to be the dead holder's is left where it
 * is, never put back over the lock path nor removed, and the lock waits for its stale window instead.
 */
export function takeOverDeadHolder(lockPath: string): boolean {
	const record = readHolderRecord(lockPath);
	if (record === undefined || lockHolder(lockPath) !== record.lock || holderMayRun(record)) return false;
	const release = takeTakeoverMutex(lockPath);
	if (release === undefined) return false;
	try {
		// Within the mutex, only this process moves the lock: if the dead holder's record and lock are still in place,
		// no other process took the lock since they were judged.
		const current = readHolderRecord(lockPath);
		if (current === undefined || !sameRecord(current, record) || lockHolder(lockPath) !== record.lock) return false;
		const aside = `${lockPath}.${randomUUID()}.dead`;
		try {
			renameSync(lockPath, aside);
		} catch {
			return false;
		}
		if (lockHolder(aside) !== record.lock) return false;
		rmSync(aside, { recursive: true, force: true });
		return true;
	} finally {
		release();
	}
}

function sameRecord(a: LockHolderRecord, b: LockHolderRecord): boolean {
	return a.host === b.host && a.pid === b.pid && a.started === b.started && a.lock === b.lock;
}
