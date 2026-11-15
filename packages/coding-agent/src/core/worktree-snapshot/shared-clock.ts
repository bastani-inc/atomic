/**
 * One clock for files several hosts share (#5050). A lease or lock is judged stale by how long ago its holder last
 * refreshed it, and its holder and a reader may run on different hosts whose clocks disagree. Comparing the mtime one
 * host's clock stamped with another host's clock lets a live holder on a host whose clock lags lose its slot, and a
 * crashed holder whose clock runs ahead keep it for as long as the skew. Here both sides go by the clock of the
 * filesystem holding the file instead: how far it runs from this process's clock is measured by writing a probe file
 * next to the file, whose mtime the filesystem stamps, so holders stamp refresh times in the filesystem's clock and
 * readers measure ages in it.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile, { type LockOptions } from "proper-lockfile";

/** How long a measured offset of a directory's filesystem clock is reused before it is measured again. */
const OFFSET_REUSE_MS = 10_000;
/** Times a probe file's name may hold: never a name the pool, restore or seed code reads. */
const PROBE_PREFIX = ".clock-";

const offsets = new Map<string, { offset: number; measured: number }>();

/**
 * How far the clock of the filesystem holding `directory` runs ahead of this process's clock, in milliseconds: the
 * mtime the filesystem stamps on a file written in `directory` now, less this process's time now. Measured again
 * after {@link OFFSET_REUSE_MS}; 0, this process's own clock, when no file can be written there.
 */
export async function sharedClockOffset(directory: string): Promise<number> {
	const cached = offsets.get(directory);
	const now = Date.now();
	if (cached !== undefined && now >= cached.measured && now - cached.measured < OFFSET_REUSE_MS) return cached.offset;
	const probe = join(directory, `${PROBE_PREFIX}${randomUUID()}.probe`);
	try {
		const before = Date.now();
		await writeFile(probe, "0", { mode: 0o600 });
		const { mtimeMs } = await stat(probe);
		const after = Date.now();
		const offset = mtimeMs - (before + after) / 2;
		offsets.set(directory, { offset, measured: after });
		return offset;
	} catch {
		return cached?.offset ?? 0;
	} finally {
		await rm(probe, { force: true }).catch(() => {});
	}
}

/** The time now by the clock of the filesystem holding `directory`, which every host sharing it reads alike. */
export async function sharedClockNow(directory: string): Promise<number> {
	return Date.now() + (await sharedClockOffset(directory));
}

/**
 * How each lock file's mtime, in the filesystem's clock, reads in this process's clock, by lock file: the same mtime
 * always reads the same, so a holder finds the mtime it stamped unchanged even once the offset was measured again.
 */
const readings = new Map<string, { shared: number; local: number }>();
/** Readings kept at most: older ones are dropped, as only the holder of a lock needs its own. */
const MAX_READINGS = 1_024;

function remember(path: string, shared: number, local: number): void {
	readings.delete(path);
	readings.set(path, { shared, local });
	if (readings.size > MAX_READINGS) readings.delete(readings.keys().next().value!);
}

function sharedStat(path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void) {
	const file = String(path);
	sharedClockOffset(dirname(file)).then((offset) =>
		fs.stat(file, (error, stats) => {
			if (error) return callback(error);
			const shared = stats.mtime.getTime();
			const reading = readings.get(file);
			const local = reading?.shared === shared ? reading.local : shared - offset;
			remember(file, shared, local);
			callback(null, Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mtime: new Date(local) }));
		}),
	);
}

function sharedUtimes(
	path: fs.PathLike,
	atime: fs.TimeLike,
	mtime: fs.TimeLike,
	callback: (error: NodeJS.ErrnoException | null) => void,
) {
	const file = String(path);
	const local = new Date(mtime).getTime();
	sharedClockOffset(dirname(file)).then((offset) => {
		const shared = new Date(local + offset);
		fs.utimes(file, atime, shared, (error) => {
			if (error) return callback(error);
			fs.stat(file, (statError, stats) => {
				if (!statError) remember(file, stats.mtime.getTime(), local);
				callback(null);
			});
		});
	});
}

function sharedRmdir(path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) {
	readings.delete(String(path));
	fs.rmdir(path, callback);
}

/**
 * The file system proper-lockfile works through: a lock's mtime is stamped and read in the filesystem's clock, while
 * proper-lockfile compares it with this process's clock, so a lock refreshed on a host whose clock is off by minutes
 * or days still reads as refreshed when it was (#5050).
 */
const sharedClockFs = { ...fs, stat: sharedStat, utimes: sharedUtimes, rmdir: sharedRmdir };

/**
 * Takes a proper-lockfile lock of `path` whose staleness every host sharing it judges by the clock of the filesystem
 * holding it (#5050): a holder on a host whose clock lags keeps its lock, and one whose clock runs ahead loses it once
 * it stopped refreshing it for the stale time.
 */
export function lockShared(path: string, options: LockOptions): Promise<() => Promise<void>> {
	return lockfile.lock(path, { ...options, fs: sharedClockFs });
}
