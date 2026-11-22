import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import {
	HOLDER_TEMP_STALE_MS,
	lockHolderAsync,
	lockHolderPath,
	prepareTakeoverMutex,
	processMayRun,
	processMayRunAsync,
	putBack,
	putBackAsync,
	removeAside,
	removeAsideAsync,
	removeLeftoverHolderFiles,
	removeLeftoverHolderFilesAsync,
	takeTakeoverMutex,
	takeTakeoverMutexAsync,
} from "./lock-takeover.js";

export { HOLDER_TEMP_STALE_MS, lockHolderPath, prepareTakeoverMutex };

import { lockHolder } from "./lock-wait.ts";
import { processStartToken, processStartTokenAsync } from "./process-start-token.js";
import { renameReplacing, renameReplacingAsync } from "./rename-retry.ts";

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

let ownStart: Promise<string | undefined> | undefined;

export async function recordLockHolderAsync(lockPath: string): Promise<void> {
	const lock = await lockHolderAsync(lockPath);
	if (lock === undefined) return;
	ownStart ??= processStartTokenAsync(process.pid);
	const record: LockHolderRecord = { host: hostname(), pid: process.pid, started: await ownStart, lock };
	const path = lockHolderPath(lockPath);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(record));
		await renameReplacingAsync(temporary, path);
	} catch {
		await rm(temporary, { force: true });
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

export async function clearLockHolderAsync(lockPath: string): Promise<void> {
	try {
		await rm(lockHolderPath(lockPath), { force: true });
	} catch {}
}

function readHolderRecord(lockPath: string): LockHolderRecord | undefined {
	try {
		return parseHolderRecord(readFileSync(lockHolderPath(lockPath), "utf8"));
	} catch {
		return undefined;
	}
}

async function readHolderRecordAsync(lockPath: string): Promise<LockHolderRecord | undefined> {
	try {
		return parseHolderRecord(await readFile(lockHolderPath(lockPath), "utf8"));
	} catch {
		return undefined;
	}
}

function parseHolderRecord(content: string): LockHolderRecord | undefined {
	const record = JSON.parse(content) as Partial<LockHolderRecord>;
	if (typeof record.host !== "string" || !Number.isSafeInteger(record.pid) || typeof record.lock !== "string")
		return undefined;
	if (record.started !== undefined && typeof record.started !== "string") return undefined;
	return record as LockHolderRecord;
}

export async function prepareLockTakeover(lockPath: string): Promise<void> {
	await prepareTakeoverMutex(lockPath, await readHolderRecordAsync(lockPath));
}

/**
 * Removes the lock directory at `lockPath` when its holder is proven dead, so the next attempt to take it follows at
 * once; true when it did. Takeovers are serialized by the takeover mutex, an advisory lock the kernel releases when
 * its holder dies (#5193), and the whole move runs while it is held: the holder record and the lock directory are
 * checked again inside it, so a lock another process took after the dead holder's is never moved. A directory that,
 * once moved, turns out not to be the dead holder's is put back only while the lock path is free, never replacing
 * anything, and otherwise left aside, never removed.
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
		if (lockHolder(aside) !== record.lock) {
			putBack(aside, lockPath);
			return false;
		}
		removeAside(aside);
		removeLeftoverHolderFiles(lockPath);
		return true;
	} finally {
		mutex.release();
	}
}

export async function takeOverDeadHolderAsync(lockPath: string): Promise<boolean> {
	const record = await readHolderRecordAsync(lockPath);
	if (record === undefined || (await lockHolderAsync(lockPath)) !== record.lock || (await processMayRunAsync(record)))
		return false;
	const mutex = await takeTakeoverMutexAsync(lockPath);
	if (mutex === undefined) return false;
	try {
		const current = await readHolderRecordAsync(lockPath);
		if (current === undefined || !sameRecord(current, record) || (await lockHolderAsync(lockPath)) !== record.lock)
			return false;
		const aside = `${lockPath}.${randomUUID()}.dead`;
		if (!(await mutex.owned())) return false;
		try {
			await rename(lockPath, aside);
		} catch {
			return false;
		}
		if ((await lockHolderAsync(aside)) !== record.lock) {
			await putBackAsync(aside, lockPath);
			return false;
		}
		await removeAsideAsync(aside);
		await removeLeftoverHolderFilesAsync(lockPath);
		return true;
	} finally {
		await mutex.release();
	}
}

function sameRecord(a: LockHolderRecord, b: LockHolderRecord): boolean {
	return a.host === b.host && a.pid === b.pid && a.started === b.started && a.lock === b.lock;
}
