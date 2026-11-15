import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

let ownStart: string | undefined | null = null;

/** When this process started, read once. */
function ownStartToken(): string | undefined {
	if (ownStart === null) ownStart = processStartToken(process.pid);
	return ownStart;
}

/**
 * Names this process as the holder of the lock directory at `lockPath`, which it has just taken. Best effort: a lock
 * whose holder is not named is only taken over once it is stale.
 */
export function recordLockHolder(lockPath: string): void {
	const lock = lockHolder(lockPath);
	if (lock === undefined) return;
	const record: LockHolderRecord = { host: hostname(), pid: process.pid, started: ownStartToken(), lock };
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
		if (typeof record.host !== "string" || !Number.isSafeInteger(record.pid) || typeof record.lock !== "string")
			return undefined;
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

/**
 * Removes the lock directory at `lockPath` when its holder is proven dead, so the next attempt to take it follows at
 * once; true when it did. The directory is first moved aside under a name of its own, and removed only when it is
 * still the one the dead holder took, so a lock another process took in the meantime is put back.
 */
export function takeOverDeadHolder(lockPath: string): boolean {
	const record = readHolderRecord(lockPath);
	if (record === undefined || lockHolder(lockPath) !== record.lock || holderMayRun(record)) return false;
	const aside = `${lockPath}.${randomUUID()}.dead`;
	try {
		renameSync(lockPath, aside);
	} catch {
		return false;
	}
	if (lockHolder(aside) !== record.lock) {
		try {
			renameSync(aside, lockPath);
		} catch {
			rmSync(aside, { recursive: true, force: true });
		}
		return false;
	}
	rmSync(aside, { recursive: true, force: true });
	return true;
}
