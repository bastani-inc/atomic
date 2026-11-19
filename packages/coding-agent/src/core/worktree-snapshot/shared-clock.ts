/**
 * One clock for files several hosts share (#5050). A lease or lock is judged stale by how long ago its holder last
 * refreshed it, and its holder and a reader may run on different hosts whose clocks disagree. Comparing the mtime one
 * host's clock stamped with another host's clock lets a live holder on a host whose clock lags lose its slot, and a
 * crashed holder whose clock runs ahead keep it for as long as the skew. Here both sides go by the clock of the
 * filesystem holding the file instead: how far it runs from this process's clock is measured by writing a probe file
 * next to the file, whose mtime the filesystem stamps, so holders stamp refresh times in the filesystem's clock and
 * readers measure ages in it.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, toNamespacedPath } from "node:path";
import type * as native from "@bastani/atomic-natives";
import lockfile, { type LockOptions } from "proper-lockfile";

// A cold lock must not resolve the optional package. A loaded package can disappear when its host unloads it.
const loadedKey = Symbol.for("@bastani/atomic/windows-temporary@3");
export function windowsTemporaryFiles(): typeof native | undefined {
	if (process.platform !== "win32") return undefined;
	const host = process as NodeJS.Process & { [loadedKey]?: WeakRef<typeof native> };
	try {
		return loadedKey in host ? host[loadedKey]?.deref() : undefined;
	} catch {
		return undefined;
	}
}

const PROBE_NAME = /^\.clock-[0-9a-f]{16}\.probe$/;

/**
 * How old, by the filesystem's clock, a probe file is when its process no longer has a use for it: one lives for a
 * create and a stat, so one this old was left by a process that stopped between creating and removing it.
 */
export const LEFTOVER_PROBE_AGE_MS = 10 * 60_000;

/** When each directory's leftover probes were last removed by this process, by this process's clock. */
const sweptAt = new Map<string, number>();

/** Removes the probes in `directory` older than {@link LEFTOVER_PROBE_AGE_MS}, at most once per that age. */
async function removeLeftoverProbes(directory: string, offset: number, clock: () => number): Promise<void> {
	const last = sweptAt.get(directory);
	if (last !== undefined && Date.now() - last < LEFTOVER_PROBE_AGE_MS) return;
	sweptAt.set(directory, Date.now());
	const now = clock() + offset;
	for (const name of await readdir(directory).catch(() => [] as string[])) {
		if (!PROBE_NAME.test(name)) continue;
		const probe = join(directory, name);
		const age = await stat(probe).then(
			(stats) => now - stats.mtimeMs,
			() => 0,
		);
		if (age > LEFTOVER_PROBE_AGE_MS) {
			// Only ask for deletion access to an old file. On Windows recheck its age on the handle we remove.
			const sweep = windowsTemporaryFiles()?.removeWindowsFileOlderThan(
				toNamespacedPath(probe),
				now - LEFTOVER_PROBE_AGE_MS,
			);
			await (sweep ?? unlink(probe)).catch(() => {});
		}
	}
}

function probePath(directory: string): string {
	// Probe names must not consume a UUID from the caller's record sequence.
	return join(directory, `.clock-${randomBytes(8).toString("hex")}.probe`);
}

/** A cold reading needs only a descriptor, not a FileHandle or an optional native operation. */
function ordinaryReading(directory: string, clock: () => number, absolute: boolean, retry = true): Promise<number> {
	const probe = probePath(directory);
	const before = clock();
	return new Promise((resolve, reject) => {
		fs.open(probe, "wx", (error, fd) => {
			if (error)
				return resolve(
					retry && error.code === "EEXIST"
						? ordinaryReading(directory, clock, absolute, false)
						: absolute
							? Date.now()
							: 0,
				);
			const finish = (offset?: number) =>
				fs.unlink(probe, () => {
					if (offset === undefined) return resolve(absolute ? Date.now() : 0);
					removeLeftoverProbes(directory, offset, clock).then(
						() => resolve(absolute ? clock() + offset : offset),
						reject,
					);
				});
			fs.close(fd, (error) => {
				if (error) return finish();
				fs.stat(probe, (error, stats) => finish(error ? undefined : stats.mtimeMs - (before + clock()) / 2));
			});
		});
	});
}

/**
 * How far the clock of the filesystem holding `directory` runs ahead of this process's clock, in milliseconds: the
 * mtime the filesystem stamps on a file created in `directory` now, less this process's time now. The probe file,
 * `.clock-<random hex>.probe`, is removed at once. 0, this process's own clock, when no file can be created there.
 * Probes a process left when it stopped mid-probe are removed once they are {@link LEFTOVER_PROBE_AGE_MS} old by the
 * filesystem's clock.
 */
export function sharedClockOffset(directory: string): Promise<number> {
	return sampleClock(directory, false);
}

/** An absolute reading advances the filesystem's timestamp by elapsed time, independent of civil clock steps. */
export function sharedClockNow(directory: string): Promise<number> {
	return sampleClock(directory, true);
}

function sampleClock(directory: string, absolute: boolean): Promise<number> {
	const binding = windowsTemporaryFiles();
	if (!binding) return ordinaryReading(directory, absolute ? () => performance.now() : Date.now, absolute);
	// Windows' performance counter includes sleep. Convert its filesystem reading to the current civil offset
	// after cleanup. On the ordinary relative path keep the wall-clock midpoint, including on hosts whose
	// monotonic clock stops in suspend.
	return windowsReading(directory, () => performance.now(), absolute, binding);
}

async function windowsReading(
	directory: string,
	clock: () => number,
	absolute: boolean,
	binding: typeof native,
): Promise<number> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const probe = probePath(directory);
		let reading: native.WindowsClockReading | null | undefined;
		let offset: number;
		try {
			const before = clock();
			// Runtime fs.open namespaces Windows paths before passing them to libuv (e.g. a literal trailing dot).
			reading = await binding.readWindowsClockProbe(toNamespacedPath(probe));
			// No native create was attempted if this host did not export its file operations.
			if (!reading) return ordinaryReading(directory, absolute ? clock : Date.now, absolute, attempt === 0);
			// Only creation brackets the stamp. The worker's duration cannot extend beyond the caller's
			// observed interval (the two clocks may have different resolution).
			const createMs = Math.min(reading.createdInMs, Math.max(0, clock() - before));
			offset = reading.mtimeMs - (before + createMs / 2);
		} catch (error) {
			if ((error as Error).message === "EEXIST") continue;
			break;
		} finally {
			if (reading?.pending) await reading.pending.close().catch(() => {});
		}
		await removeLeftoverProbes(directory, offset, clock);
		const now = clock() + offset;
		return absolute ? now : now - Date.now();
	}
	return absolute ? Date.now() : 0;
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
