import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * `path` with every symbolic link on it resolved, including dangling ones: the real path of its deepest existing
 * ancestor, with the components below it appended unchanged. A dangling link is followed to the path it names, so
 * the result is where a write through `path` would land. Unlike `existsSync`, the walk uses `lstat`, so a link whose
 * target is missing is never mistaken for a missing component. A link cycle fails with `realpath`'s `ELOOP`; any error
 * other than a missing component is rethrown.
 */
export function resolvePhysicalPath(path: string): string {
	let current = resolve(path);
	for (;;) {
		const missing: string[] = [];
		let existing = current;
		for (;;) {
			try {
				lstatSync(existing);
				break;
			} catch (error) {
				if (!isMissing(error)) throw error;
				if (dirname(existing) === existing) return current;
				missing.unshift(basename(existing));
				existing = dirname(existing);
			}
		}
		try {
			return join(realpathSync.native(existing), ...missing);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		// `existing` is present but cannot be resolved: it is a link whose chain ends at a missing path.
		const parent = realpathSync.native(dirname(existing));
		current = resolve(parent, readlinkSync(existing), ...missing);
	}
}
