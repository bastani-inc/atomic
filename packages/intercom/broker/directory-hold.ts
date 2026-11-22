import { type BigIntStats, closeSync, constants, fstatSync, openSync, statSync } from "node:fs";

/** A directory as it was when it was held, told apart from one created later at the same path. */
export interface HeldDirectory {
	/** Whether the directory at its path is still the one held: false once it was removed, or removed and made again. */
	held(): boolean;
	/** Let go of it; only for a holder that ends before its process does. */
	release(): void;
}

function identityOf(stats: BigIntStats): string {
	return process.platform === "win32" ? `${stats.dev}:${stats.ino}:${stats.birthtimeNs}` : `${stats.dev}:${stats.ino}`;
}

/** The socket at `path`, by its exact device and 64-bit inode; undefined when it is gone or unreadable. */
export function socketPathIdentity(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return undefined;
	}
}

/**
 * Holds the directory at `path`, or `undefined` when there is none. Outside Windows it is kept open for as long as the
 * process runs: while it is, its inode is not given to a directory created at the path after it was removed, so its
 * device and inode tell the two apart. A creation time would not: where the system cannot report one, it is the change
 * time, which every file written in the directory moves. Windows keeps no directory open this way, and there its file
 * id and creation time tell them apart. A directory that cannot be opened is told apart by device and inode alone.
 */
export function holdDirectory(path: string): HeldDirectory | undefined {
	let identity: string;
	let fd: number | undefined;
	try {
		if (process.platform !== "win32")
			try {
				fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
			} catch {
				fd = undefined;
			}
		const stats = fd === undefined ? statSync(path, { bigint: true }) : fstatSync(fd, { bigint: true });
		if (!stats.isDirectory()) throw new Error(`${path} is not a directory`);
		identity = identityOf(stats);
	} catch {
		if (fd !== undefined) closeSync(fd);
		return undefined;
	}
	return {
		held: () => {
			try {
				const stats = statSync(path, { bigint: true });
				return stats.isDirectory() && identityOf(stats) === identity;
			} catch {
				return false;
			}
		},
		release: () => {
			if (fd === undefined) return;
			closeSync(fd);
			fd = undefined;
		},
	};
}
