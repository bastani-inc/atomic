import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { unreadablePathError } from "./errors.ts";

/**
 * `path` with every symbolic link in its existing part resolved: the real path of its deepest existing ancestor, with
 * the components below it appended unchanged. Snapshot roots are Git's physical top levels, so a working directory
 * reached through a link compares and maps against them only in this form, and a checkout that no longer exists still
 * maps by its spelling. A component that exists but cannot be resolved fails with `unreadable-path`.
 */
export function canonicalizeWorktreePath(path: string): string {
	const absolute = resolve(path);
	const missing: string[] = [];
	for (let current = absolute; ; current = dirname(current)) {
		try {
			return join(realpathSync.native(current), ...missing.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw unreadablePathError(current, error);
			if (dirname(current) === current) return absolute;
			missing.push(basename(current));
		}
	}
}
