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
import { open, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile, { type LockOptions } from "proper-lockfile";

const PROBE_NAME = /^\.clock-[0-9a-f]{16}\.probe$/;

/**
 * How old, by the filesystem's clock, a probe file is when its process no longer has a use for it: one lives for a
 * create and a stat, so one this old was left by a process that stopped between creating and removing it, or that
 * could not remove it.
 */
export const LEFTOVER_PROBE_AGE_MS = 10 * 60_000;

/** When each directory's leftover probes were last removed by this process, by this process's clock. */
const sweptAt = new Map<string, number>();

/** The probes of this process that it could not delete, by directory. */
const undeleted = new Map<string, string[]>();

/**
 * Deletes `probe` with one attempt, never waiting to try again: a lock's refresh reads the filesystem's clock, and must
 * not wait out another program (an antivirus scan, the indexer) that has the new file open and makes Windows refuse
 * the delete. Whether it is gone; any error is kept from the caller.
 */
async function deleteProbe(probe: string): Promise<boolean> {
	try {
		await unlink(probe);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Tries once more to delete the probes this process could not delete by its earlier probes in `directory`. One that
 * still cannot be deleted is left to {@link removeLeftoverProbes}, once it is {@link LEFTOVER_PROBE_AGE_MS} old.
 */
async function removeUndeletedProbes(directory: string): Promise<void> {
	const own = undeleted.get(directory);
	if (own === undefined) return;
	undeleted.delete(directory);
	for (const probe of own) await deleteProbe(probe);
}

/** Removes the probes in `directory` older than {@link LEFTOVER_PROBE_AGE_MS}, at most once per that age. */
async function removeLeftoverProbes(directory: string, offset: number): Promise<void> {
	const last = sweptAt.get(directory);
	if (last !== undefined && Date.now() - last < LEFTOVER_PROBE_AGE_MS) return;
	sweptAt.set(directory, Date.now());
	const now = Date.now() + offset;
	for (const name of await readdir(directory).catch(() => [] as string[])) {
		if (!PROBE_NAME.test(name)) continue;
		const probe = join(directory, name);
		const age = await stat(probe).then(
			(stats) => now - stats.mtimeMs,
			() => 0,
		);
		if (age > LEFTOVER_PROBE_AGE_MS) await unlink(probe).catch(() => {});
	}
}

/**
 * How far the clock of the filesystem holding `directory` runs ahead of this process's clock, in milliseconds: the
 * mtime the filesystem stamps on a file created in `directory` now, less this process's time now. The probe file,
 * `.clock-<random hex>.probe`, is removed at once; when its delete fails, as when Windows refuses it for a moment, the
 * delete is tried again by this process's next probe in `directory`. 0, this process's own clock, when no file can be
 * created there. Probes a process left when it stopped mid-probe, or could not delete, are removed once they are
 * {@link LEFTOVER_PROBE_AGE_MS} old by the filesystem's clock.
 */
export async function sharedClockOffset(directory: string): Promise<number> {
	// Random bytes, not a UUID: the probe's name never takes a UUID the caller's own records draw.
	const probe = join(directory, `.clock-${randomBytes(8).toString("hex")}.probe`);
	let created = false;
	let offset: number | undefined;
	try {
		const before = Date.now();
		const file = await open(probe, "w");
		created = true;
		await file.close();
		const { mtimeMs } = await stat(probe);
		offset = mtimeMs - (before + Date.now()) / 2;
	} catch {
		// No file can be created or read in `directory`: this process's own clock.
	}
	const kept = created && !(await deleteProbe(probe));
	await removeUndeletedProbes(directory);
	if (offset !== undefined) await removeLeftoverProbes(directory, offset);
	// Recorded only now, so that the next probe in `directory`, not this one, tries it again.
	if (kept) undeleted.set(directory, [...(undeleted.get(directory) ?? []), probe]);
	return offset ?? 0;
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
