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
import { open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile, { type LockOptions } from "proper-lockfile";

/**
 * How far the clock of the filesystem holding `directory` runs ahead of this process's clock, in milliseconds: the
 * mtime the filesystem stamps on a file created in `directory` now, less this process's time now. The probe file,
 * `.clock-<random>.probe`, is removed at once. 0, this process's own clock, when no file can be created there.
 */
export async function sharedClockOffset(directory: string): Promise<number> {
	const probe = join(directory, `.clock-${randomUUID()}.probe`);
	try {
		const before = Date.now();
		await (await open(probe, "w")).close();
		const { mtimeMs } = await stat(probe);
		return mtimeMs - (before + Date.now()) / 2;
	} catch {
		return 0;
	} finally {
		await unlink(probe).catch(() => {});
	}
}

/** The time now by the clock of the filesystem holding `directory`, which every host sharing it reads alike. */
export async function sharedClockNow(directory: string): Promise<number> {
	return Date.now() + (await sharedClockOffset(directory));
}

/**
 * How each lock file's mtime, in the filesystem's clock, reads in this process's clock, by lock file: the same mtime
 * always reads the same, so a holder finds the mtime it stamped unchanged, though the offset is measured anew each
 * time. A lock's reading is dropped when the lock is removed.
 */
const readings = new Map<string, { shared: number; local: number }>();

function remember(path: string, shared: number, local: number): void {
	readings.set(path, { shared, local });
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
