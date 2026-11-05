import { realpathSync, statSync } from "node:fs";

/**
 * What a file is, whatever path names it: its device and inode (a hard link shares both, a symlink resolves to them),
 * or its real path on a file system that reports no inode. Undefined when the file does not exist.
 */
export function fileIdentity(path: string): string | undefined {
	try {
		const { dev, ino } = statSync(path, { bigint: true });
		if (ino !== 0n) return `${dev}:${ino}`;
		const real = realpathSync.native(path);
		return `path:${process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real}`;
	} catch {
		return undefined;
	}
}

/** Whether two paths name the same existing file. */
export function isSameFile(left: string, right: string): boolean {
	const identity = fileIdentity(left);
	return identity !== undefined && identity === fileIdentity(right);
}
