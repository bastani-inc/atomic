import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { link, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createModuleRequire } from "../utils/module-require.js";
import { pathExists } from "../utils/path-exists.ts";
import {
	processStartToken,
	processStartTokenAsync,
	processStartTokenForSynchronousTakeover,
	readProcessStartToken,
} from "./process-start-token.js";

/*
 * Every removal of another process's lock goes through one mutex per lock (#5161): the takeover of a lock whose
 * holder is proven dead, and proper-lockfile's own removal of a stale lock. Each checks again, inside the mutex, that
 * the lock is still the one it judged, so a lock another process took since is never removed.
 *
 * The mutex is an operating-system advisory lock on a file beside the lock (#5193): `flock` on Unix, `LockFileEx` on
 * Windows, through the native module. The kernel releases it when its holder dies, so no process ever judges another's
 * mutex stale, and a pause or a crash can never admit two holders. Without the native lock, as with a native module
 * built before it, the mutex is a directory whose owner is judged as before, with a one-time warning.
 */

/** How old a directory takeover mutex that names no owner must be before it is judged left by a killed process. */
export const TAKEOVER_MUTEX_STALE_MS = 10_000;

/** How long a taker waits for the advisory lock while another process holds it: a takeover takes milliseconds. */
export const TAKEOVER_MUTEX_WAIT_MS = 250;

/** The directory that serializes takeovers of the lock at `lockPath` without the native advisory lock. */
export function takeoverMutexPath(lockPath: string): string {
	return `${lockPath}.takeover`;
}

/**
 * The file whose advisory lock serializes takeovers of the lock at `lockPath`. It is never removed: a process that
 * removed it could leave one holder locking the removed file while another locks a new one.
 */
export function takeoverLockPath(lockPath: string): string {
	return `${lockPath}.takeover.lock`;
}

/** The native module's advisory lock and no-replace rename (#5193). */
export interface NativeLocks {
	tryAdvisoryLock(path: string, waitMs: number): { release(): void } | null;
	renameNoReplace(from: string, to: string): boolean;
	tryAdvisoryLockAsync?(path: string, waitMs: number): Promise<{ release(): void } | null>;
	renameNoReplaceAsync?(from: string, to: string): Promise<boolean>;
}

let nativeLocks: NativeLocks | null | undefined;
let warnedFallback = false;

/** The native module's locks, or null where the module or those bindings (added in #5193) are missing. */
function locks(): NativeLocks | null {
	if (nativeLocks === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as Partial<NativeLocks>;
			nativeLocks =
				typeof binding.tryAdvisoryLock === "function" && typeof binding.renameNoReplace === "function"
					? (binding as NativeLocks)
					: null;
		} catch {
			nativeLocks = null;
		}
	}
	return nativeLocks;
}

/** Replaces the native locks for a test: null as without the native module, undefined to load them again. */
export function setNativeLocksForTesting(value: NativeLocks | null | undefined): void {
	nativeLocks = value;
	warnedFallback = false;
	warnedUnopenable.clear();
}

interface AsyncNativeLocks {
	tryAdvisoryLock(path: string, waitMs: number): Promise<{ release(): void } | null>;
	renameNoReplace(from: string, to: string): Promise<boolean>;
}

const ADVISORY_LOCK_RETRY_MS = 5;

function asyncLocks(): AsyncNativeLocks | null {
	const native = locks();
	if (native === null) return null;
	const { tryAdvisoryLockAsync, renameNoReplaceAsync } = native;
	if (typeof tryAdvisoryLockAsync === "function" && typeof renameNoReplaceAsync === "function") {
		return {
			tryAdvisoryLock: (path, waitMs) => tryAdvisoryLockAsync.call(native, path, waitMs),
			renameNoReplace: (from, to) => renameNoReplaceAsync.call(native, from, to),
		};
	}
	return {
		tryAdvisoryLock: async (path, waitMs) => {
			const deadline = Date.now() + waitMs;
			for (;;) {
				const lock = native.tryAdvisoryLock(path, 0);
				const remainingMs = deadline - Date.now();
				if (lock !== null || remainingMs <= 0) return lock;
				await sleep(Math.min(ADVISORY_LOCK_RETRY_MS, remainingMs));
			}
		},
		renameNoReplace: async (from, to) => native.renameNoReplace(from, to),
	};
}

function warnFallback(): void {
	if (warnedFallback) return;
	warnedFallback = true;
	process.emitWarning(
		"The native module has no advisory file lock; lock takeovers use a directory mutex instead, which a process killed while taking it leaves for 10 seconds (#5193).",
	);
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
export function processMayRun(record: ProcessRecord, readStart = processStartToken): boolean {
	if (record.host !== hostname()) return true;
	const started = record.started === undefined ? undefined : readStart(record.pid);
	if (started !== undefined) return started === record.started;
	return processAlive(record.pid);
}

export async function processMayRunAsync(record: ProcessRecord): Promise<boolean> {
	if (record.host !== hostname()) return true;
	const started = record.started === undefined ? undefined : await processStartTokenAsync(record.pid);
	if (started !== undefined) return started === record.started;
	return processAlive(record.pid);
}

let ownStart: Promise<string | undefined> | undefined;

function ownStartToken(): Promise<string | undefined> {
	ownStart ??= processStartTokenAsync(process.pid);
	return ownStart;
}

export async function prepareProcessRecord(record: ProcessRecord | undefined): Promise<void> {
	if (record === undefined || record.host !== hostname() || record.started === undefined) return;
	await readProcessStartToken(record.pid);
}

export async function prepareTakeoverMutex(lockPath: string, holder?: ProcessRecord): Promise<void> {
	const owner = await readMutexOwnerAsync(takeoverMutexPath(lockPath));
	const prepareRecords = () => Promise.all([prepareProcessRecord(owner), prepareProcessRecord(holder)]);
	await Promise.all([readProcessStartToken(process.pid), prepareRecords()]);
	await prepareRecords();
}

/** Which directory `path` is now, or undefined when none is there or it is being removed. */
export function lockHolder(lockPath: string): string | undefined {
	try {
		const stats = statSync(lockPath, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
	} catch {
		// None is there, or, on Windows, it is being removed and refuses to be stat'ed: it is changing hands.
		return undefined;
	}
}

export async function lockHolderAsync(lockPath: string): Promise<string | undefined> {
	try {
		const stats = await stat(lockPath, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

interface MutexOwner extends ProcessRecord {
	/** Tells this taking of the mutex apart from any other by the same process. */
	readonly id: string;
}

function readMutexOwner(mutexPath: string): MutexOwner | undefined {
	try {
		return parseMutexOwner(readFileSync(mutexOwnerPath(mutexPath), "utf8"));
	} catch {
		return undefined;
	}
}

async function readMutexOwnerAsync(mutexPath: string): Promise<MutexOwner | undefined> {
	try {
		return parseMutexOwner(await readFile(mutexOwnerPath(mutexPath), "utf8"));
	} catch {
		return undefined;
	}
}

function parseMutexOwner(content: string): MutexOwner | undefined {
	const owner = JSON.parse(content) as Partial<MutexOwner>;
	if (typeof owner.id !== "string" || !Number.isSafeInteger(owner.pid)) return undefined;
	if (owner.started !== undefined && typeof owner.started !== "string") return undefined;
	return owner as MutexOwner;
}

async function statIfPresent(path: string): Promise<nodeFs.Stats | undefined> {
	try {
		return await stat(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

/** A takeover mutex this process took. */
export interface TakeoverMutex {
	/**
	 * Whether this process still owns the mutex: checked just before a lock is moved or removed. An advisory lock is
	 * owned until it is released; only a directory mutex can be lost.
	 */
	owned(): boolean;
	/** Gives the mutex up, when this process still owns it. */
	release(): void;
}

export interface AsyncTakeoverMutex {
	owned(): Promise<boolean>;
	release(): Promise<void>;
}

const warnedUnremovable = new Set<string>();

/**
 * Removes `path`, a lock, claim or mutex moved aside or a staging directory, which is no longer at any lock's path
 * (#5193). Removing it is only tidying: when it fails, as for a directory another user owns (left by `sudo atomic`),
 * it is left where it is with a one-time warning, and the takeover goes on.
 */
export function removeAside(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (error) {
		warnUnremovable(path, error);
	}
}

export async function removeAsideAsync(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		warnUnremovable(path, error);
	}
}

function warnUnremovable(path: string, error: unknown): void {
	if (warnedUnremovable.has(path)) return;
	warnedUnremovable.add(path);
	const reason = error instanceof Error ? error.message : String(error);
	process.emitWarning(
		`${path}, left by a lock takeover, cannot be removed (${reason}). It holds no lock: remove it, or give it to your user (for example \`sudo chown -R $USER ${path}\`), as one an \`atomic\` run as another user can leave behind (#5193).`,
	);
}

/**
 * Removes the takeover mutex at `mutexPath` when it is stale: its owner is proven dead, or it names no owner and is
 * {@link TAKEOVER_MUTEX_STALE_MS} old. It is moved aside first and removed only when it is still the mutex judged, so a
 * mutex another process took meanwhile is never removed; true when the mutex is gone.
 */
function removeStaleMutex(mutexPath: string, readStart: typeof processStartToken): boolean {
	const judged = lockHolder(mutexPath);
	if (judged === undefined) return true;
	const owner = readMutexOwner(mutexPath);
	if (owner !== undefined) {
		if (processMayRun(owner, readStart)) return false;
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
	removeAside(aside);
	return true;
}

async function removeStaleMutexAsync(mutexPath: string): Promise<boolean> {
	const judged = await lockHolderAsync(mutexPath);
	if (judged === undefined) return true;
	const owner = await readMutexOwnerAsync(mutexPath);
	if (owner !== undefined) {
		if (await processMayRunAsync(owner)) return false;
	} else {
		const stats = await statIfPresent(mutexPath);
		if (stats !== undefined && Date.now() - stats.mtimeMs < TAKEOVER_MUTEX_STALE_MS) return false;
	}
	const aside = `${mutexPath}.${randomUUID()}.dead`;
	try {
		await rename(mutexPath, aside);
	} catch {
		return false;
	}
	if ((await lockHolderAsync(aside)) !== judged || (await readMutexOwnerAsync(aside))?.id !== owner?.id) return false;
	await removeAsideAsync(aside);
	return true;
}

/**
 * Takes the takeover mutex of the lock at `lockPath` (#5193): the advisory lock of {@link takeoverLockPath}, waiting
 * up to `waitMs` while another process holds it, and then the owner-checked directory mutex of
 * {@link takeDirectoryMutex}, so a process without the native lock never takes over while one with it does. Undefined
 * while another process holds either. The advisory lock is held on an open file until released, and the kernel
 * releases it when this process dies; the directory mutex of a dead holder is freed by its owner check.
 *
 * Without the native lock, or when the lock file cannot be opened (as one left by `sudo atomic`, owned by root), only
 * the directory mutex is taken, with a one-time warning.
 */
export function takeTakeoverMutex(
	lockPath: string,
	waitMs: number = TAKEOVER_MUTEX_WAIT_MS,
	readStart = processStartToken,
): TakeoverMutex | undefined {
	const native = locks();
	if (native === null) {
		warnFallback();
		return takeDirectoryMutex(lockPath, undefined, readStart);
	}
	const file = takeoverLockPath(lockPath);
	let lock: { release(): void } | null;
	try {
		lock = native.tryAdvisoryLock(file, waitMs);
	} catch (error) {
		// A missing directory is no lock to take at all: the directory mutex cannot be made either.
		if (existsSync(dirname(lockPath))) warnUnopenable(file, error);
		return takeDirectoryMutex(lockPath, undefined, readStart);
	}
	if (lock === null) return undefined;
	removeLeftoverStaging(lockPath);
	const directory = takeDirectoryMutex(lockPath, native, readStart);
	if (directory === undefined) {
		lock.release();
		return undefined;
	}
	let held = true;
	return {
		owned: () => held && directory.owned(),
		release: () => {
			held = false;
			directory.release();
			// Releasing the native lock again does nothing.
			lock.release();
		},
	};
}

export async function takeTakeoverMutexAsync(
	lockPath: string,
	waitMs: number = TAKEOVER_MUTEX_WAIT_MS,
): Promise<AsyncTakeoverMutex | undefined> {
	const native = asyncLocks();
	if (native === null) {
		warnFallback();
		return takeDirectoryMutexAsync(lockPath);
	}
	const file = takeoverLockPath(lockPath);
	let lock: { release(): void } | null;
	try {
		lock = await native.tryAdvisoryLock(file, waitMs);
	} catch (error) {
		if (await pathExists(dirname(lockPath))) warnUnopenable(file, error);
		return takeDirectoryMutexAsync(lockPath);
	}
	if (lock === null) return undefined;
	const advisory = lock;
	await removeLeftoverStagingAsync(lockPath);
	const directory = await takeDirectoryMutexAsync(lockPath, native);
	if (directory === undefined) {
		advisory.release();
		return undefined;
	}
	let held = true;
	return {
		owned: async () => held && (await directory.owned()),
		release: async () => {
			held = false;
			await directory.release();
			advisory.release();
		},
	};
}

const warnedUnopenable = new Set<string>();

function warnUnopenable(file: string, error: unknown): void {
	if (warnedUnopenable.has(file)) return;
	warnedUnopenable.add(file);
	const reason = error instanceof Error ? error.message : String(error);
	process.emitWarning(
		`The lock file ${file} cannot be opened (${reason}); lock takeovers use a directory mutex instead, which a process killed while taking it leaves for 10 seconds. Remove the file, or give it to your user (for example \`sudo chown $USER ${file}\`), as one an \`atomic\` run as another user can leave behind (#5193).`,
	);
}

/**
 * Puts `aside`, moved from `path` and found not to be the item judged, back at `path` only while nothing is there,
 * never replacing anything (#5193): a file is linked back, a directory renamed back without replacing. True when it
 * is back; otherwise it is left aside, as is a directory without the native rename.
 */
export function putBack(aside: string, path: string): boolean {
	try {
		if (statSync(aside).isDirectory()) {
			const native = locks();
			return native?.renameNoReplace(aside, path) === true;
		}
		linkSync(aside, path);
		unlinkSync(aside);
		return true;
	} catch {
		return false;
	}
}

export async function putBackAsync(aside: string, path: string): Promise<boolean> {
	try {
		if ((await stat(aside)).isDirectory()) {
			const native = asyncLocks();
			return (await native?.renameNoReplace(aside, path)) === true;
		}
		await link(aside, path);
		await unlink(aside);
		return true;
	} catch {
		return false;
	}
}

/**
 * Takes the directory takeover mutex of the lock at `lockPath`, without the native advisory lock: creates its
 * directory and names this process as its owner. Undefined while another process holds it. A mutex whose owner is
 * proven dead is removed, as is one that names no owner once it is {@link TAKEOVER_MUTEX_STALE_MS} old; a live owner
 * keeps its mutex however long it holds it.
 */
function takeDirectoryMutex(
	lockPath: string,
	native: NativeLocks | undefined,
	readStart: typeof processStartToken,
): TakeoverMutex | undefined {
	const path = takeoverMutexPath(lockPath);
	const owner: MutexOwner = {
		host: hostname(),
		pid: process.pid,
		started: readStart(process.pid),
		id: randomUUID(),
	};
	const owned = () => readMutexOwner(path)?.id === owner.id;
	const mutex: TakeoverMutex = {
		owned,
		release: () => {
			if (!owned()) return;
			try {
				if (native === undefined) {
					rmSync(mutexOwnerPath(path), { force: true });
					rmdirSync(path);
					return;
				}
				// Moved away whole, so the mutex is never seen without its owner; a leftover is removed later.
				const leaving = staging(path);
				renameSync(path, leaving);
				rmSync(leaving, { recursive: true, force: true });
			} catch {
				// Left behind, it names this process, and its owner check frees it once this process is gone.
			}
		},
	};
	const take = (): TakeoverMutex | undefined => {
		if (native !== undefined) return createWithOwner(path, owner, native) ? mutex : undefined;
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
		return mutex;
	};
	return take() ?? (removeStaleMutex(path, readStart) ? take() : undefined);
}

async function takeDirectoryMutexAsync(
	lockPath: string,
	native?: AsyncNativeLocks,
): Promise<AsyncTakeoverMutex | undefined> {
	const path = takeoverMutexPath(lockPath);
	const owner: MutexOwner = {
		host: hostname(),
		pid: process.pid,
		started: await ownStartToken(),
		id: randomUUID(),
	};
	const owned = async () => (await readMutexOwnerAsync(path))?.id === owner.id;
	const mutex: AsyncTakeoverMutex = {
		owned,
		release: async () => {
			if (!(await owned())) return;
			try {
				if (native === undefined) {
					await rm(mutexOwnerPath(path), { force: true });
					await rmdir(path);
					return;
				}
				const leaving = staging(path);
				await rename(path, leaving);
				await rm(leaving, { recursive: true, force: true });
			} catch {}
		},
	};
	const take = async (): Promise<AsyncTakeoverMutex | undefined> => {
		if (native !== undefined) return (await createWithOwnerAsync(path, owner, native)) ? mutex : undefined;
		try {
			await mkdir(path);
		} catch {
			return undefined;
		}
		try {
			await writeFile(mutexOwnerPath(path), JSON.stringify(owner));
		} catch {}
		return mutex;
	};
	return (await take()) ?? ((await removeStaleMutexAsync(path)) ? take() : undefined);
}

/** A name beside the directory mutex at `path` for one being made or removed by a process holding the advisory lock. */
function staging(path: string): string {
	return `${path}.${randomUUID()}.tmp`;
}

/**
 * Makes the directory mutex at `path` with its owner already inside (#5193): it is made under a name of its own and
 * moved into place only while nothing is there, so a process killed meanwhile never leaves a mutex that names no owner,
 * which would be kept for {@link TAKEOVER_MUTEX_STALE_MS}. True when it is in place.
 */
function createWithOwner(path: string, owner: MutexOwner, native: NativeLocks): boolean {
	const made = staging(path);
	try {
		mkdirSync(made);
		writeFileSync(mutexOwnerPath(made), JSON.stringify(owner));
		if (native.renameNoReplace(made, path)) return true;
	} catch {
		// Not made: the mutex is not taken.
	}
	removeAside(made);
	return false;
}

async function createWithOwnerAsync(path: string, owner: MutexOwner, native: AsyncNativeLocks): Promise<boolean> {
	const made = staging(path);
	try {
		await mkdir(made);
		await writeFile(mutexOwnerPath(made), JSON.stringify(owner));
		if (await native.renameNoReplace(made, path)) return true;
	} catch {}
	await removeAsideAsync(made);
	return false;
}

/**
 * Removes the staging directories of {@link createWithOwner} and of releases that processes killed meanwhile left
 * beside the directory mutex of `lockPath`. Only a process holding the advisory lock makes them, so one seen by the
 * holder of that lock is a leftover.
 */
function removeLeftoverStaging(lockPath: string): void {
	const path = takeoverMutexPath(lockPath);
	const prefix = `${basename(path)}.`;
	try {
		for (const name of readdirSync(dirname(path))) {
			if (name.startsWith(prefix) && name.endsWith(".tmp"))
				rmSync(join(dirname(path), name), { recursive: true, force: true });
		}
	} catch {
		// Best effort: a leftover is only clutter.
	}
}

async function removeLeftoverStagingAsync(lockPath: string): Promise<void> {
	const path = takeoverMutexPath(lockPath);
	const prefix = `${basename(path)}.`;
	try {
		for (const name of await readdir(dirname(path))) {
			if (name.startsWith(prefix) && name.endsWith(".tmp"))
				await rm(join(dirname(path), name), { recursive: true, force: true });
		}
	} catch {}
}

/** The file beside lock directory `lockPath` that names its holder. */
export function lockHolderPath(lockPath: string): string {
	return `${lockPath}.holder`;
}

/** How old a holder record's temporary file must be before it is judged left by a killed writer and removed. */
export const HOLDER_TEMP_STALE_MS = 60_000;

/**
 * Removes the temporary files of holder records for the lock at `lockPath` that writers killed mid-write left, once
 * they are {@link HOLDER_TEMP_STALE_MS} old. Called under the takeover mutex whenever a lock is taken over or removed
 * as stale, since a writer killed before its record was in place leaves a lock that is only ever removed as stale.
 */
export function removeLeftoverHolderFiles(lockPath: string): void {
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

export async function removeLeftoverHolderFilesAsync(lockPath: string): Promise<void> {
	const directory = dirname(lockPath);
	const prefix = `${basename(lockHolderPath(lockPath))}.`;
	try {
		for (const name of await readdir(directory)) {
			if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
			const path = join(directory, name);
			const stats = await statIfPresent(path);
			if (stats !== undefined && Date.now() - stats.mtimeMs > HOLDER_TEMP_STALE_MS) await rm(path, { force: true });
		}
	} catch {}
}

/**
 * Removes the lock directory at `lockPath` that proper-lockfile judged stale, older than `staleMs`, under the takeover
 * mutex (#5161). proper-lockfile checks a lock's age and then removes it, so two processes
 * that both saw a stale lock could each remove it, the second removing the lock the first had just taken. Inside the
 * mutex the directory is removed only while it is still stale, so a lock taken since is never removed. When the mutex
 * is held elsewhere or the lock is fresh again, nothing is removed and the next attempt finds the lock held.
 */
export function removeStaleLock(lockPath: string, staleMs: number, readStart = processStartToken): void {
	const mutex = takeTakeoverMutex(lockPath, TAKEOVER_MUTEX_WAIT_MS, readStart);
	if (mutex === undefined) return;
	try {
		const stats = statSync(lockPath, { throwIfNoEntry: false });
		if (stats === undefined || Date.now() - stats.mtimeMs <= staleMs || !mutex.owned()) return;
		rmdirSync(lockPath);
		removeLeftoverHolderFiles(lockPath);
	} finally {
		mutex.release();
	}
}

export async function removeStaleLockAsync(lockPath: string, staleMs: number): Promise<void> {
	const mutex = await takeTakeoverMutexAsync(lockPath);
	if (mutex === undefined) return;
	try {
		const stats = await statIfPresent(lockPath);
		if (stats === undefined || Date.now() - stats.mtimeMs <= staleMs || !(await mutex.owned())) return;
		await rmdir(lockPath);
		await removeLeftoverHolderFilesAsync(lockPath);
	} finally {
		await mutex.release();
	}
}

/** The file system proper-lockfile is given to take one lock, and {@link LockRemovalGuard.done} once it is taken. */
export interface LockRemovalGuard {
	readonly fs: typeof nodeFs;
	/** Ends the guard: from now on, removing the lock is this process releasing its own lock. */
	done(): void;
}

/**
 * A file system for proper-lockfile's asynchronous `lock` that, while the lock at `lockPath` is being taken, removes a
 * stale lock only through {@link removeStaleLockAsync} with the caller's `staleMs`, the stale window proper-lockfile was
 * given. Once {@link LockRemovalGuard.done} is called, the lock's own release removes it directly.
 */
export function guardLockRemoval(lockPath: string, staleMs: number): LockRemovalGuard {
	const target = resolve(lockPath);
	let taking = true;
	const rmdir = ((path: nodeFs.PathLike, ...rest: unknown[]) => {
		if (!taking || resolve(String(path)) !== target) {
			nodeFs.rmdir(path, ...(rest as [nodeFs.NoParamCallback]));
			return;
		}
		const callback = rest.at(-1) as nodeFs.NoParamCallback;
		removeStaleLockAsync(target, staleMs).then(
			() => callback(null),
			(error: NodeJS.ErrnoException) => callback(error),
		);
	}) as typeof nodeFs.rmdir;
	return {
		fs: { ...nodeFs, rmdir },
		done: () => {
			taking = false;
		},
	};
}

export function guardLockRemovalSync(lockPath: string, staleMs: number): LockRemovalGuard {
	const target = resolve(lockPath);
	let taking = true;
	const rmdirSync = ((path: nodeFs.PathLike, options?: nodeFs.RmDirOptions) => {
		if (taking && resolve(String(path)) === target)
			removeStaleLock(target, staleMs, processStartTokenForSynchronousTakeover);
		else nodeFs.rmdirSync(path, options);
	}) as typeof nodeFs.rmdirSync;
	return {
		fs: { ...nodeFs, rmdirSync },
		done: () => {
			taking = false;
		},
	};
}
