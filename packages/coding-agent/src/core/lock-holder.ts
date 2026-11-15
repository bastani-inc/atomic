import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { processMayRun, takeTakeoverMutex } from "./lock-takeover.ts";
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

/** How old a holder record's temporary file must be before it is judged left by a killed writer and removed. */
export const HOLDER_TEMP_STALE_MS = 60_000;

/**
 * Removes the temporary files of holder records for the lock at `lockPath` that writers killed mid-write left, once
 * they are {@link HOLDER_TEMP_STALE_MS} old. Called under the takeover mutex, after a takeover.
 */
function removeLeftoverHolderFiles(lockPath: string): void {
	const directory = dirname(lockPath);
	const prefix = `${basename(lockHolderPath(lockPath))}.`;
	try {
		for (const name of readdirSync(directory)) {
			if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
			const path = join(directory, name);
			const stats = statSync(path, { throwIfNoEntry: false });
			if (stats !== undefined && Date.now() - stats.mtimeMs > HOLDER_TEMP_STALE_MS) rmSync(path, { force: true });
		}
	} catch {
		// Best effort: a leftover file is only clutter.
	}
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

/**
 * Removes the lock directory at `lockPath` when its holder is proven dead, so the next attempt to take it follows at
 * once; true when it did. Takeovers are serialized by a mutex of their own, and inside it the holder record and the
 * lock directory are checked again just before the directory is moved aside, so a lock another process took after the
 * dead holder's is never moved. A directory that, once moved, turns out not to be the dead holder's is left where it
 * is, never put back over the lock path nor removed, and the lock waits for its stale window instead.
 */
export function takeOverDeadHolder(lockPath: string): boolean {
	const record = readHolderRecord(lockPath);
	if (record === undefined || lockHolder(lockPath) !== record.lock || processMayRun(record)) return false;
	const mutex = takeTakeoverMutex(lockPath);
	if (mutex === undefined) return false;
	try {
		// Within the mutex, only this process moves the lock: if the dead holder's record and lock are still in place,
		// no other process took the lock since they were judged.
		const current = readHolderRecord(lockPath);
		if (current === undefined || !sameRecord(current, record) || lockHolder(lockPath) !== record.lock) return false;
		const aside = `${lockPath}.${randomUUID()}.dead`;
		// A process paused here for long keeps its mutex while it runs; one that lost it moves nothing.
		if (!mutex.owned()) return false;
		try {
			renameSync(lockPath, aside);
		} catch {
			return false;
		}
		if (lockHolder(aside) !== record.lock) return false;
		rmSync(aside, { recursive: true, force: true });
		removeLeftoverHolderFiles(lockPath);
		return true;
	} finally {
		mutex.release();
	}
}

function sameRecord(a: LockHolderRecord, b: LockHolderRecord): boolean {
	return a.host === b.host && a.pid === b.pid && a.started === b.started && a.lock === b.lock;
}
