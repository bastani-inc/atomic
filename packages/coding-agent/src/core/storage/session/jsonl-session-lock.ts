import {
	type BigIntStats,
	close as closeCallback,
	mkdir as mkdirCallback,
	open as openCallback,
	rmdir as rmdirCallback,
	stat as statCallback,
	utimes as utimesCallback,
	write as writeCallback,
} from "node:fs";
import { readFile, rename, unlink } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModuleRequire } from "../../../utils/module-require.js";
import { fileGenerationOf } from "../creation-time.js";

/**
 * File-system calls used to manage the `<dir>/.session.lock` directory, replaceable so tests can fault
 * directory creation, inspection, timestamp updates, and removal (such as transient Windows `EPERM` errors).
 */
export interface SessionLockFs {
	mkdir: typeof import("node:fs").mkdir;
	rmdir: typeof import("node:fs").rmdir;
	stat: typeof import("node:fs").stat;
	utimes: typeof import("node:fs").utimes;
	realpath: typeof import("node:fs").realpath;
}

/** An operating-system advisory lock handle held on an open file descriptor until `release()` or process exit. */
export interface AdvisoryLockHandle {
	release(): void;
}

/** Native advisory locking and atomic non-replacing rename bindings from `@bastani/atomic-natives`. */
export interface NativeSessionLocks {
	tryAdvisoryLockAsync(path: string, waitMs: number): Promise<AdvisoryLockHandle | null>;
	trySharedAdvisoryLockAsync(path: string, waitMs: number): Promise<AdvisoryLockHandle | null>;
	renameNoReplaceAsync(from: string, to: string): Promise<boolean>;
}

/** Fixed number of per-session-file stripe lock files kept in a JSONL store directory. */
export const SESSION_LOCK_STRIPE_COUNT = 32;

/**
 * Longest Windows lock path passed verbatim to native Win32 calls (`CreateFileW` / `MoveFileExW`):
 * paths above this threshold use `\\?\` extended-length form to avoid Windows `MAX_PATH` (260-char) failures.
 */
const WINDOWS_PLAIN_LOCK_PATH_LIMIT = 240;

/** Formats `path` for native advisory lock and rename calls, using `\\?\` extended-length paths on Windows when long. */
export function nativeLockPath(path: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return path;
	return win32.resolve(path).length > WINDOWS_PLAIN_LOCK_PATH_LIMIT ? win32.toNamespacedPath(path) : path;
}

/** Older proper-lockfile builds judge `<dir>/.session.lock` stale after 10 seconds without an mtime refresh. */
const LEGACY_LOCK_STALE_MS = 10_000;
/**
 * Group lock directories are stamped at an even integer second 2–4 seconds behind `Date.now()`:
 * strictly earlier than any directory an older build creates at or after the same clock tick, exact on
 * filesystems down to 2-second mtime granularity, and well inside the 10-second legacy stale window.
 */
const GROUP_LOCK_BACKDATE_MS = 2_000;
/** How often a live member refreshes `<dir>/.session.lock`'s mtime so older builds never judge a long-lived group stale. */
const GROUP_LOCK_HEARTBEAT_MS = 3_000;
/** Maximum age at which a group-owned `<dir>/.session.lock` is guaranteed fresh against older builds' 10 s stale check. */
const GROUP_LOCK_FRESH_MS = 8_000;
/** Age at which a joiner proactively refreshes an active group's `<dir>/.session.lock` while holding `.gate`. */
const GROUP_LOCK_REFRESH_ON_JOIN_MS = 5_000;
/** Maximum age allowed for a staged lock directory before placing it onto `<dir>/.session.lock`. */
const GROUP_LOCK_PLACE_MAX_AGE_MS = 5_000;
/** Wait slice for contended kernel advisory lock acquisition so cancellation stays prompt. */
const ADVISORY_WAIT_CHUNK_MS = 25;
/** Poll interval while waiting for an older build holding `<dir>/.session.lock`. */
const LEGACY_POLL_MS = 5;

/** Removing a lock directory fails with these on Windows while another handle, such as a scanner or indexer, holds it. */
export const TRANSIENT_RELEASE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
/** Waits between attempts to take or remove a lock directory, about 1.5 s in all, far inside the 10 s stale window. */
export const LOCK_BACKOFF_MS = [10, 20, 50, 100, 200, 400, 700];

const ALL_STRIPE_INDICES: readonly number[] = Array.from({ length: SESSION_LOCK_STRIPE_COUNT }, (_, index) => index);

/** Most recently observed group record per lockPath, capped to avoid unbounded growth across ephemeral directories. */
const lastSeenGroupRecords = new Map<string, GroupLockRecord>();
const MAX_CACHED_GROUP_RECORDS = 256;

function rememberGroupRecord(lockPath: string, record: GroupLockRecord): void {
	lastSeenGroupRecords.delete(lockPath);
	lastSeenGroupRecords.set(lockPath, record);
	if (lastSeenGroupRecords.size > MAX_CACHED_GROUP_RECORDS) {
		lastSeenGroupRecords.delete(lastSeenGroupRecords.keys().next().value as string);
	}
}

let nativeSessionLocks: NativeSessionLocks | null | undefined;

/** Loads `@bastani/atomic-natives`'s async advisory lock and non-replacing rename bindings, or null if absent. */
export function loadNativeSessionLocks(): NativeSessionLocks | null {
	if (nativeSessionLocks === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as Partial<NativeSessionLocks>;
			nativeSessionLocks =
				typeof binding.tryAdvisoryLockAsync === "function" &&
				typeof binding.trySharedAdvisoryLockAsync === "function" &&
				typeof binding.renameNoReplaceAsync === "function"
					? {
							tryAdvisoryLockAsync: (path, waitMs) => binding.tryAdvisoryLockAsync!(path, waitMs),
							trySharedAdvisoryLockAsync: (path, waitMs) => binding.trySharedAdvisoryLockAsync!(path, waitMs),
							renameNoReplaceAsync: (from, to) => binding.renameNoReplaceAsync!(from, to),
						}
					: null;
		} catch {
			nativeSessionLocks = null;
		}
	}
	return nativeSessionLocks;
}

/** Replaces the native advisory lock bindings for tests: `null` simulates absence, `undefined` reloads the real module. */
export function setNativeSessionLocksForTesting(value: NativeSessionLocks | null | undefined): void {
	nativeSessionLocks = value;
}

/** Deterministic FNV-1a stripe index in `[0, SESSION_LOCK_STRIPE_COUNT)` for a session file basename. */
export function sessionLockStripe(name: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < name.length; index++) {
		hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193);
	}
	return (hash >>> 0) % SESSION_LOCK_STRIPE_COUNT;
}

/** Distinct stripe indices for `paths`, sorted in strictly ascending order to prevent lock-order cycles. */
export function sortedStripesForPaths(paths: readonly string[]): number[] {
	const set = new Set<number>();
	for (const path of paths) set.add(sessionLockStripe(basename(path)));
	return [...set].sort((a, b) => a - b);
}

/** Scope of fine-grained locks held inside the mixed-version group lock. */
export type SessionLockScope =
	| { readonly kind: "full" }
	| { readonly kind: "list" }
	| { readonly kind: "create"; readonly path: string }
	| { readonly kind: "files"; readonly paths: readonly string[] }
	| { readonly kind: "stripes"; readonly stripes: readonly number[]; readonly create: boolean };

/** Internal sentinel thrown when a cached session path resolved to a file outside the currently held stripes. */
export class RelockRequiredError extends Error {
	readonly path: string;
	constructor(path: string) {
		super(`Session file ${path} requires a different lock stripe`);
		this.name = "RelockRequiredError";
		this.path = path;
	}
}

interface GroupLockRecord {
	readonly generation: string;
	readonly mtimeNs: string;
	readonly nextMtimeNs?: string;
}

export interface HeldGroupLock {
	readonly lockPath: string;
	release(): Promise<void>;
}

export interface HeldFineLocks {
	readonly stripes: ReadonlySet<number>;
	release(): void;
}

type DirectoryLockFs = Pick<SessionLockFs, "mkdir" | "rmdir" | "stat" | "utimes">;

function defaultDirectoryFs(lockFs?: SessionLockFs): DirectoryLockFs {
	return lockFs ?? { mkdir: mkdirCallback, rmdir: rmdirCallback, stat: statCallback, utimes: utimesCallback };
}

function gateLockPath(lockPath: string): string {
	return `${lockPath}.gate`;
}

function membersLockPath(lockPath: string): string {
	return `${lockPath}.members`;
}

function groupRecordPath(lockPath: string): string {
	return `${lockPath}.group`;
}

function groupRecordTmpPath(lockPath: string): string {
	return `${lockPath}.group.tmp`;
}

function stagingDirPath(lockPath: string): string {
	return `${lockPath}.staging`;
}

function deadDirPath(lockPath: string): string {
	return `${lockPath}.dead`;
}

function createLockPath(lockPath: string): string {
	return `${lockPath}.create`;
}

function stripeLockPath(lockPath: string, stripe: number): string {
	return `${lockPath}.stripe.${stripe}`;
}

function backdatedLockMtimeMs(nowMs = Date.now()): number {
	return Math.floor((nowMs - GROUP_LOCK_BACKDATE_MS) / 2_000) * 2_000;
}

function ageMsOf(stats: BigIntStats, nowMs = Date.now()): number {
	return nowMs - Number(stats.mtimeNs / 1_000_000n);
}

function matchesGroupRecord(stats: BigIntStats, record: GroupLockRecord): boolean {
	if (fileGenerationOf(stats) !== record.generation) return false;
	const mtimeNs = String(stats.mtimeNs);
	return mtimeNs === record.mtimeNs || (record.nextMtimeNs !== undefined && mtimeNs === record.nextMtimeNs);
}

function isWindowsTransientPermissionError(error: unknown): boolean {
	if (process.platform !== "win32") return false;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "EPERM") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\(os error (?:5|32)\)/i.test(message);
}

function isTransientDirectoryError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
	if (TRANSIENT_RELEASE_CODES.has(code)) return true;
	return isWindowsTransientPermissionError(error);
}

function statBigInt(fs: Pick<SessionLockFs, "stat">, path: string): Promise<BigIntStats | undefined> {
	return new Promise((resolve, reject) => {
		fs.stat(path, { bigint: true }, (error, stats) => {
			if (!error) {
				resolve(stats);
				return;
			}
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				resolve(undefined);
				return;
			}
			reject(error);
		});
	});
}

function mkdirDirectory(fs: Pick<SessionLockFs, "mkdir">, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.mkdir(path, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export function removeDirectory(fs: Pick<SessionLockFs, "rmdir">, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.rmdir(path, (error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") reject(error);
			else resolve();
		});
	});
}

function utimesDirectory(fs: Pick<SessionLockFs, "utimes">, path: string, timeMs: number): Promise<void> {
	const time = new Date(timeMs);
	return new Promise((resolve, reject) => {
		fs.utimes(path, time, time, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function readGroupRecord(path: string): Promise<GroupLockRecord | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as Partial<GroupLockRecord>;
		if (typeof parsed.generation !== "string" || typeof parsed.mtimeNs !== "string") return undefined;
		if (parsed.nextMtimeNs !== undefined && typeof parsed.nextMtimeNs !== "string") return undefined;
		return {
			generation: parsed.generation,
			mtimeNs: parsed.mtimeNs,
			...(parsed.nextMtimeNs !== undefined ? { nextMtimeNs: parsed.nextMtimeNs } : {}),
		};
	} catch {
		return undefined;
	}
}

function openFd(path: string, flags: string, mode?: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const cb = (error: NodeJS.ErrnoException | null, fd: number) => {
			if (error) reject(error);
			else resolve(fd);
		};
		if (mode === undefined) openCallback(path, flags, cb);
		else openCallback(path, flags, mode, cb);
	});
}

function writeFd(fd: number, payload: Buffer, offset: number, length: number): Promise<number> {
	return new Promise((resolve, reject) => {
		writeCallback(fd, payload, offset, length, (error, bytesWritten) => {
			if (error) reject(error);
			else resolve(bytesWritten);
		});
	});
}

function closeFd(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		closeCallback(fd, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function writeGroupRecord(path: string, record: GroupLockRecord): Promise<void> {
	const payload = Buffer.from(JSON.stringify(record));
	const fd = await openFd(path, "w", 0o600);
	try {
		for (let offset = 0; offset < payload.length; ) {
			offset += await writeFd(fd, payload, offset, payload.length - offset);
		}
	} finally {
		await closeFd(fd);
	}
}

async function writeGroupRecordAtomic(path: string, tmpPath: string, record: GroupLockRecord): Promise<void> {
	try {
		await writeGroupRecord(tmpPath, record);
		await rename(tmpPath, path);
	} catch (error) {
		await unlink(tmpPath).catch(() => undefined);
		throw error;
	}
}

async function clearGroupRecord(path: string): Promise<void> {
	let fd: number;
	try {
		fd = await openFd(path, "w", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await closeFd(fd);
}

async function callAdvisoryWithWindowsBackoff<T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	let refusals = 0;
	for (;;) {
		signal?.throwIfAborted();
		try {
			return await attempt();
		} catch (error) {
			if (isWindowsTransientPermissionError(error) && refusals < LOCK_BACKOFF_MS.length) {
				signal?.throwIfAborted();
				await delay(LOCK_BACKOFF_MS[refusals++]);
				continue;
			}
			throw error;
		}
	}
}

async function tryAdvisoryExclusiveZero(
	native: NativeSessionLocks,
	path: string,
	signal?: AbortSignal,
): Promise<AdvisoryLockHandle | null> {
	const target = nativeLockPath(path);
	return callAdvisoryWithWindowsBackoff(() => native.tryAdvisoryLockAsync(target, 0), signal);
}

async function acquireAdvisoryExclusive(
	native: NativeSessionLocks,
	path: string,
	signal?: AbortSignal,
): Promise<AdvisoryLockHandle> {
	const target = nativeLockPath(path);
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		const waitMs = attempt < 3 ? 0 : ADVISORY_WAIT_CHUNK_MS;
		const lock = await callAdvisoryWithWindowsBackoff(() => native.tryAdvisoryLockAsync(target, waitMs), signal);
		if (lock !== null) return lock;
		if (attempt < 2) {
			signal?.throwIfAborted();
			await delay(1);
		}
	}
}

async function acquireAdvisoryShared(
	native: NativeSessionLocks,
	path: string,
	signal?: AbortSignal,
): Promise<AdvisoryLockHandle> {
	const target = nativeLockPath(path);
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		const waitMs = attempt < 3 ? 0 : ADVISORY_WAIT_CHUNK_MS;
		const lock = await callAdvisoryWithWindowsBackoff(
			() => native.trySharedAdvisoryLockAsync(target, waitMs),
			signal,
		);
		if (lock !== null) return lock;
		if (attempt < 2) {
			signal?.throwIfAborted();
			await delay(1);
		}
	}
}

async function renameNoReplaceWithBackoff(
	native: NativeSessionLocks,
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const source = nativeLockPath(from);
	const destination = nativeLockPath(to);
	return callAdvisoryWithWindowsBackoff(() => native.renameNoReplaceAsync(source, destination), signal);
}

async function mkdirWithWindowsBackoff(
	fs: Pick<SessionLockFs, "mkdir">,
	path: string,
	signal?: AbortSignal,
): Promise<void> {
	let refusals = 0;
	for (;;) {
		signal?.throwIfAborted();
		try {
			await mkdirDirectory(fs, path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" && process.platform === "win32" && refusals < LOCK_BACKOFF_MS.length) {
				signal?.throwIfAborted();
				await delay(LOCK_BACKOFF_MS[refusals++]);
				continue;
			}
			throw error;
		}
	}
}

/**
 * Removes `path` with Windows transient-error backoff (1 initial attempt + 7 retries).
 * Returns `true` if the directory is gone, `false` if transient Windows errors persisted through all retries.
 */
export async function removeDirectoryWithBackoff(fs: Pick<SessionLockFs, "rmdir">, path: string): Promise<boolean> {
	try {
		await removeDirectory(fs, path);
		return true;
	} catch (error) {
		if (!TRANSIENT_RELEASE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	for (const wait of LOCK_BACKOFF_MS) {
		await delay(wait);
		try {
			await removeDirectory(fs, path);
			return true;
		} catch (error) {
			if (!TRANSIENT_RELEASE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	return false;
}

/**
 * Refreshes `<dir>/.session.lock`'s mtime while holding `.gate`: records both the observed current mtime and
 * the target mtime in `.group` atomically BEFORE calling `utimes`, then commits the post-`utimes` mtime.
 */
async function refreshGroupDirLock(
	fs: Pick<SessionLockFs, "stat" | "utimes">,
	lockPath: string,
	groupPath: string,
	tmpPath: string,
	dirStats: BigIntStats,
	groupRec: GroupLockRecord,
): Promise<boolean> {
	if (!matchesGroupRecord(dirStats, groupRec)) return false;
	const targetMs = backdatedLockMtimeMs();
	const targetNs = BigInt(targetMs) * 1_000_000n;
	if (targetNs <= dirStats.mtimeNs) return true;
	const prepared: GroupLockRecord = {
		generation: groupRec.generation,
		mtimeNs: String(dirStats.mtimeNs),
		nextMtimeNs: String(targetNs),
	};
	await writeGroupRecordAtomic(groupPath, tmpPath, prepared);
	try {
		await utimesDirectory(fs, lockPath, targetMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const updated = await statBigInt(fs, lockPath);
	if (updated === undefined || fileGenerationOf(updated) !== groupRec.generation) return false;
	await writeGroupRecordAtomic(groupPath, tmpPath, {
		generation: groupRec.generation,
		mtimeNs: String(updated.mtimeNs),
	});
	return true;
}

/**
 * Clears an abandoned `<dir>/.session.lock` while holding `.gate` and exclusive `.members` (proving zero other
 * new-version members are alive).
 *
 * - Fresh lock matching `.group` (crashed new group or failed Windows `rmdir`): removed immediately without waiting
 *   for the 10 s legacy stale window.
 * - Stale lock (old crashed new group or stale legacy lock): atomically moved aside to `.dead`, re-verified against
 *   the judged `(generation, mtimeNs)`, and deleted only if unchanged; if a live legacy writer replaced it first,
 *   the directory is placed back via `renameNoReplace` and never deleted.
 * - Live legacy lock: left untouched and returns `false`.
 */
export async function clearUnreleasedGroupLock(
	native: NativeSessionLocks,
	fs: Pick<SessionLockFs, "rmdir" | "stat">,
	lockPath: string,
	dirStats: BigIntStats,
	signal?: AbortSignal,
): Promise<boolean> {
	const groupPath = groupRecordPath(lockPath);
	const deadPath = deadDirPath(lockPath);
	const groupRec = await readGroupRecord(groupPath);
	const isOurs = groupRec !== undefined && matchesGroupRecord(dirStats, groupRec);
	const ageMs = ageMsOf(dirStats);

	if (isOurs && ageMs < GROUP_LOCK_FRESH_MS) {
		try {
			await removeDirectory(fs, lockPath);
		} catch (error) {
			if (isTransientDirectoryError(error)) return false;
			throw error;
		}
		await clearGroupRecord(groupPath);
		return true;
	}

	if (!isOurs && ageMs <= LEGACY_LOCK_STALE_MS) return false;

	const judgedGeneration = fileGenerationOf(dirStats);
	const judgedMtimeNs = dirStats.mtimeNs;
	try {
		await rename(lockPath, deadPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (isTransientDirectoryError(error)) return false;
		throw error;
	}

	const movedStats = await statBigInt(fs, deadPath);
	if (movedStats === undefined) return true;
	if (fileGenerationOf(movedStats) === judgedGeneration && movedStats.mtimeNs === judgedMtimeNs) {
		await removeDirectoryWithBackoff(fs, deadPath);
		if (isOurs) await clearGroupRecord(groupPath);
		return true;
	}

	// Another process replaced `<dir>/.session.lock` right before our rename: restore it without replacing anything.
	await renameNoReplaceWithBackoff(native, deadPath, lockPath, signal).catch(() => false);
	return false;
}

/**
 * Joins the mixed-version group holding `<dir>/.session.lock`, excluding older proper-lockfile writers while
 * allowing concurrent new-version writers to proceed to per-session-file locks.
 */
export async function acquireSessionGroupLock(
	native: NativeSessionLocks,
	directory: string,
	options: {
		readonly lockFs?: SessionLockFs;
		readonly signal?: AbortSignal;
		readonly onCompromised: (cause: Error) => void;
	},
): Promise<HeldGroupLock> {
	const lockPath = join(directory, ".session.lock");
	const gatePath = gateLockPath(lockPath);
	const membersPath = membersLockPath(lockPath);
	const groupPath = groupRecordPath(lockPath);
	const groupTmpPath = groupRecordTmpPath(lockPath);
	const stagingPath = stagingDirPath(lockPath);
	const deadPath = deadDirPath(lockPath);
	const fs = defaultDirectoryFs(options.lockFs);
	const { signal, onCompromised } = options;

	let membersSh: AdvisoryLockHandle | undefined;
	let knownRecord: GroupLockRecord | undefined;

	for (;;) {
		signal?.throwIfAborted();
		let gate: AdvisoryLockHandle | null = await acquireAdvisoryExclusive(native, gatePath, signal);
		let membersEx: AdvisoryLockHandle | null = null;
		let retryAfterDelay = false;

		try {
			membersEx = await tryAdvisoryExclusiveZero(native, membersPath, signal);
			if (membersEx === null) {
				// Another new-version member is already alive in the group: verify `<dir>/.session.lock` is still fresh.
				const dirStats = await statBigInt(fs, lockPath);
				if (dirStats !== undefined) {
					const cached = lastSeenGroupRecords.get(lockPath);
					let groupRec = cached !== undefined && matchesGroupRecord(dirStats, cached) ? cached : undefined;
					if (groupRec === undefined) {
						groupRec = await readGroupRecord(groupPath);
						if (groupRec !== undefined) rememberGroupRecord(lockPath, groupRec);
					}
					if (groupRec !== undefined && matchesGroupRecord(dirStats, groupRec)) {
						const ageMs = ageMsOf(dirStats);
						if (ageMs < GROUP_LOCK_FRESH_MS) {
							let fresh = true;
							if (ageMs >= GROUP_LOCK_REFRESH_ON_JOIN_MS) {
								fresh = await refreshGroupDirLock(fs, lockPath, groupPath, groupTmpPath, dirStats, groupRec);
								knownRecord = undefined;
								lastSeenGroupRecords.delete(lockPath);
							} else {
								knownRecord = groupRec;
							}
							if (fresh) {
								membersSh = await acquireAdvisoryShared(native, membersPath, signal);
								gate.release();
								gate = null;
								break;
							}
						}
					}
				}
				retryAfterDelay = true;
			} else {
				// Zero other live new members: recover any leftovers from a crashed process and establish `<dir>/.session.lock`.
				let [deadStats, dirStats] = await Promise.all([statBigInt(fs, deadPath), statBigInt(fs, lockPath)]);
				if (deadStats !== undefined) {
					const groupRec = await readGroupRecord(groupPath);
					const deadMatchesGroup = groupRec !== undefined && matchesGroupRecord(deadStats, groupRec);
					if (deadMatchesGroup || ageMsOf(deadStats) > LEGACY_LOCK_STALE_MS) {
						await removeDirectoryWithBackoff(fs, deadPath);
						if (deadMatchesGroup) await clearGroupRecord(groupPath);
					} else {
						await renameNoReplaceWithBackoff(native, deadPath, lockPath, signal).catch(() => false);
					}
					dirStats = await statBigInt(fs, lockPath);
				}
				if (dirStats !== undefined) {
					// If `.staging` still exists, `renameNoReplace` never succeeded: clear `.group` BEFORE removing `.staging`
					// so a legacy lock at `.session.lock` is never confused with `.staging`'s recorded identity.
					const stagingStats = await statBigInt(fs, stagingPath);
					if (stagingStats !== undefined) {
						await clearGroupRecord(groupPath);
						await removeDirectoryWithBackoff(fs, stagingPath);
						dirStats = await statBigInt(fs, lockPath);
					}
				}

				if (dirStats !== undefined) {
					const cleared = await clearUnreleasedGroupLock(native, fs, lockPath, dirStats, signal);
					if (!cleared) {
						retryAfterDelay = true;
					}
				}

				if (!retryAfterDelay) {
					// Create `.staging` (recovering from leftover `.staging` if a prior crash left one with no `.session.lock`).
					for (;;) {
						try {
							await mkdirWithWindowsBackoff(fs, stagingPath, signal);
							break;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "EEXIST") {
								await clearGroupRecord(groupPath);
								await removeDirectoryWithBackoff(fs, stagingPath);
								continue;
							}
							throw error;
						}
					}

					// Stamp backdated mtime and record `.staging`'s identity BEFORE atomic `renameNoReplace`.
					let placed = false;
					try {
						for (;;) {
							const targetMs = backdatedLockMtimeMs();
							await utimesDirectory(fs, stagingPath, targetMs);
							const stagedStats = await statBigInt(fs, stagingPath);
							if (stagedStats === undefined) {
								throw Object.assign(new Error(`Missing staged lock directory ${stagingPath}`), {
									code: "ENOENT",
								});
							}
							const record: GroupLockRecord = {
								generation: fileGenerationOf(stagedStats),
								mtimeNs: String(stagedStats.mtimeNs),
							};
							await writeGroupRecord(groupPath, record);
							knownRecord = record;
							rememberGroupRecord(lockPath, record);
							if (ageMsOf(stagedStats) >= GROUP_LOCK_PLACE_MAX_AGE_MS) continue;
							break;
						}
						placed = await renameNoReplaceWithBackoff(native, stagingPath, lockPath, signal);
					} catch (error) {
						await clearGroupRecord(groupPath).catch(() => undefined);
						await removeDirectoryWithBackoff(fs, stagingPath).catch(() => undefined);
						throw error;
					}

					if (!placed) {
						// A legacy writer raced in and created `<dir>/.session.lock`: clear `.group` BEFORE removing `.staging`.
						await clearGroupRecord(groupPath);
						await removeDirectoryWithBackoff(fs, stagingPath);
						retryAfterDelay = true;
					} else {
						// Downgrade `.members` from exclusive to shared while still holding `.gate`.
						membersEx.release();
						membersEx = null;
						membersSh = await acquireAdvisoryShared(native, membersPath, signal);
						gate.release();
						gate = null;
						break;
					}
				}
			}
		} finally {
			membersEx?.release();
			gate?.release();
		}

		if (retryAfterDelay) {
			signal?.throwIfAborted();
			await delay(LEGACY_POLL_MS);
		}
	}

	const heldShared = membersSh!;
	let heartbeatStopped = false;
	let heartbeatInFlight: Promise<void> | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	const scheduleHeartbeat = (): void => {
		if (heartbeatStopped) return;
		heartbeatTimer = setTimeout(() => {
			heartbeatTimer = undefined;
			if (heartbeatStopped) return;
			heartbeatInFlight = runHeartbeat()
				.catch(() => undefined)
				.finally(() => {
					heartbeatInFlight = undefined;
					scheduleHeartbeat();
				});
		}, GROUP_LOCK_HEARTBEAT_MS);
		heartbeatTimer.unref();
	};

	const runHeartbeat = async (): Promise<void> => {
		const gate = await tryAdvisoryExclusiveZero(native, gatePath).catch(() => null);
		if (gate === null) return;
		try {
			if (heartbeatStopped) return;
			const [dirStats, groupRec] = await Promise.all([statBigInt(fs, lockPath), readGroupRecord(groupPath)]);
			if (dirStats === undefined || groupRec === undefined || !matchesGroupRecord(dirStats, groupRec)) {
				onCompromised(
					Object.assign(new Error("Session lock directory was removed or replaced while held"), {
						code: "ECOMPROMISED",
					}),
				);
				heartbeatStopped = true;
				return;
			}
			const refreshed = await refreshGroupDirLock(fs, lockPath, groupPath, groupTmpPath, dirStats, groupRec);
			if (!refreshed) {
				onCompromised(
					Object.assign(new Error("Session lock directory could not be refreshed"), { code: "ECOMPROMISED" }),
				);
				heartbeatStopped = true;
			}
		} finally {
			gate.release();
		}
	};

	scheduleHeartbeat();

	let released = false;
	return {
		lockPath,
		release: async () => {
			if (released) return;
			released = true;
			heartbeatStopped = true;
			if (heartbeatTimer !== undefined) {
				clearTimeout(heartbeatTimer);
				heartbeatTimer = undefined;
			}
			await heartbeatInFlight;
			heldShared.release();

			const gate = await acquireAdvisoryExclusive(native, gatePath);
			try {
				const membersEx = await tryAdvisoryExclusiveZero(native, membersPath);
				if (membersEx === null) return;
				try {
					const dirStats = await statBigInt(fs, lockPath);
					if (dirStats !== undefined) {
						let isOurs = knownRecord !== undefined && matchesGroupRecord(dirStats, knownRecord);
						if (!isOurs) {
							const groupRec = await readGroupRecord(groupPath);
							isOurs = groupRec !== undefined && matchesGroupRecord(dirStats, groupRec);
						}
						if (isOurs) {
							const removed = await removeDirectoryWithBackoff(fs, lockPath);
							if (removed) {
								lastSeenGroupRecords.delete(lockPath);
								await clearGroupRecord(groupPath);
							}
						}
					}
				} finally {
					membersEx.release();
				}
			} finally {
				gate.release();
			}
		},
	};
}

/**
 * Acquires the fine-grained locks for `scope` in strict global lock order:
 * `.create` (if needed), then target `.stripe.<i>` files in strictly ascending index order.
 */
export async function acquireFineSessionLocks(
	native: NativeSessionLocks,
	lockPath: string,
	scope: SessionLockScope,
	signal?: AbortSignal,
): Promise<HeldFineLocks> {
	let needCreate = false;
	let stripeIndices: readonly number[];
	switch (scope.kind) {
		case "full":
			needCreate = true;
			stripeIndices = ALL_STRIPE_INDICES;
			break;
		case "list":
			needCreate = true;
			stripeIndices = [];
			break;
		case "create":
			needCreate = true;
			stripeIndices = [sessionLockStripe(basename(scope.path))];
			break;
		case "files":
			needCreate = false;
			stripeIndices = sortedStripesForPaths(scope.paths);
			break;
		case "stripes":
			needCreate = scope.create;
			stripeIndices = [...new Set(scope.stripes)].sort((a, b) => a - b);
			break;
	}

	const held: AdvisoryLockHandle[] = [];
	try {
		if (needCreate) {
			held.push(await acquireAdvisoryExclusive(native, createLockPath(lockPath), signal));
		}
		for (const stripe of stripeIndices) {
			held.push(await acquireAdvisoryExclusive(native, stripeLockPath(lockPath, stripe), signal));
		}
	} catch (error) {
		for (let index = held.length - 1; index >= 0; index--) held[index]!.release();
		throw error;
	}

	const stripes = new Set<number>(stripeIndices);
	let released = false;
	return {
		stripes,
		release: () => {
			if (released) return;
			released = true;
			for (let index = held.length - 1; index >= 0; index--) held[index]!.release();
		},
	};
}
