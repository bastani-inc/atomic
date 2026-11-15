import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

/** Matches the Linux limit on symbolic links followed while resolving one path. */
const MAX_SYMLINK_HOPS = 40;

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function components(path: string): string[] {
	return path.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
}

/** Whether `path` is a symbolic link, or undefined when it or one of its parents is missing. */
function lstatIsLink(path: string): boolean | undefined {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/**
 * `path` with every symbolic link on it resolved the way the kernel would, dangling ones included: where a read or
 * write through `path` would land. The walk goes one component at a time with `lstat`, follows each link it meets by
 * walking that link's target the same way, and applies `..` only to the directory already resolved before it, so a
 * target such as `dir-link/../file` climbs out of the link's real directory. Components that do not exist keep their
 * spelling; the existing part, which then holds no links, is spelled as `realpath` spells it. More than
 * `MAX_SYMLINK_HOPS` links fail with `ELOOP`; any error other than a missing component is rethrown.
 */
export function resolvePhysicalPath(path: string): string {
	const absolute = resolve(path);
	let resolved = parse(absolute).root;
	const pending = components(absolute.slice(resolved.length));
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === "..") {
			resolved = dirname(resolved);
			continue;
		}
		const next = join(resolved, part);
		if (lstatIsLink(next) !== true) {
			resolved = next;
			continue;
		}
		if (++hops > MAX_SYMLINK_HOPS)
			throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, lstat '${absolute}'`), {
				code: "ELOOP",
				errno: -constants.errno.ELOOP,
				syscall: "lstat",
				path: absolute,
			});
		const target = readlinkSync(next);
		const targetRoot = parse(target).root;
		if (targetRoot !== "") resolved = resolve(targetRoot);
		pending.unshift(...components(target.slice(targetRoot.length)));
	}
	return normalizeExisting(resolved);
}

/** `path`, whose existing part holds no links, with that part spelled as `realpath` spells it. */
function normalizeExisting(path: string): string {
	const missing: string[] = [];
	let existing = path;
	while (lstatIsLink(existing) === undefined && dirname(existing) !== existing) {
		missing.unshift(basename(existing));
		existing = dirname(existing);
	}
	return join(realpathSync.native(existing), ...missing);
}
