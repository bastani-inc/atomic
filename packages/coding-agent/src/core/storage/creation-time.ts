import { randomUUID } from "node:crypto";
import { statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether a file's creation time can tell it from another file with the same device and inode numbers.
 *
 * On macOS, APFS and HFS+ set a file's creation time back to its modified time whenever that is set earlier, as
 * `touch -t` or a backup or sync tool restoring times does, so there the creation time does not stay with the file.
 * Neither reuses an inode number, so the device and inode alone tell files apart. FAT and exFAT keep the creation
 * time, and FAT reuses an inode number as soon as it is free, so there the creation time is kept. Which kind a
 * directory is on is found once per device by setting a new file's modified time earlier and seeing whether its
 * creation time moves. Linux and Windows keep creation times, so nothing is probed there.
 */
const CREATION_TIME_CAN_MOVE = process.platform === "darwin";

/** By device, whether creation times stay put on it, as a probe found. A device not probed is taken to be APFS. */
const staysByDevice = new Map<string, boolean>();
/** Directories already probed, or being probed, so each is probed once. */
const probedDirectories = new Map<string, Promise<void>>();

interface FileIdentityStats {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeNs: bigint;
}

/** Whether files on device `dev` keep their creation time; see `CREATION_TIME_CAN_MOVE`. */
export function creationTimeStays(dev: bigint): boolean {
	return !CREATION_TIME_CAN_MOVE || staysByDevice.get(String(dev)) === true;
}

/** A file's device and inode, with its creation time where that stays put: what tells it from a file that replaced it. */
export function fileGenerationOf(stats: FileIdentityStats): string {
	return creationTimeStays(stats.dev) ? legacyFileGenerationOf(stats) : `${stats.dev}:${stats.ino}`;
}

/** The generation every platform gave a file before macOS left out the creation time, which older builds still use. */
export function legacyFileGenerationOf(stats: FileIdentityStats): string {
	return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/** A probe file's name, which no session or storage scan reads. */
function probePath(directory: string): string {
	return join(directory, `.atomic-creation-time-${randomUUID()}.tmp`);
}

/**
 * Learns whether the device `directory` is on keeps creation times, once per directory. One that cannot be written
 * stays unknown, and is taken to be APFS; one that does not exist yet is probed again next time.
 */
export function learnCreationTime(directory: string): Promise<void> {
	if (!CREATION_TIME_CAN_MOVE) return Promise.resolve();
	let probed = probedDirectories.get(directory);
	if (probed === undefined) {
		probed = (async () => {
			let dev: string;
			try {
				dev = String((await stat(directory, { bigint: true })).dev);
			} catch {
				probedDirectories.delete(directory);
				return;
			}
			if (staysByDevice.has(dev)) return;
			const path = probePath(directory);
			try {
				await writeFile(path, "", { flag: "wx" });
				const before = await stat(path, { bigint: true });
				const earlier = new Date(Number(before.birthtimeNs / 1_000_000n) - 86_400_000);
				await utimes(path, earlier, earlier);
				staysByDevice.set(dev, (await stat(path, { bigint: true })).birthtimeNs === before.birthtimeNs);
			} catch {
			} finally {
				await unlink(path).catch(() => undefined);
			}
		})();
		probedDirectories.set(directory, probed);
	}
	return probed;
}

/** `learnCreationTime` for a caller that cannot wait. */
export function learnCreationTimeSync(directory: string): void {
	if (!CREATION_TIME_CAN_MOVE || probedDirectories.has(directory)) return;
	let dev: string;
	try {
		dev = String(statSync(directory, { bigint: true }).dev);
	} catch {
		return;
	}
	probedDirectories.set(directory, Promise.resolve());
	if (staysByDevice.has(dev)) return;
	const path = probePath(directory);
	try {
		writeFileSync(path, "", { flag: "wx" });
		const before = statSync(path, { bigint: true });
		const earlier = new Date(Number(before.birthtimeNs / 1_000_000n) - 86_400_000);
		utimesSync(path, earlier, earlier);
		staysByDevice.set(dev, statSync(path, { bigint: true }).birthtimeNs === before.birthtimeNs);
	} catch {
	} finally {
		try {
			unlinkSync(path);
		} catch {}
	}
}
