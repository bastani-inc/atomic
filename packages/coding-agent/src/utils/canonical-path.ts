import { realpath, realpathSync } from "node:fs";
import { realpath as realpathNative } from "node:fs/promises";
import { promisify } from "node:util";

// On POSIX, fs.promises.realpath (native realpath(3)) matches realpathSync identically in a single syscall,
// avoiding Node's multi-lstat JS realpath loop. On Windows, keep JS realpath so 8.3 short paths and drive-letter
// casing remain identical to canonicalizePath (realpathSync).
const realpathAsync = process.platform === "win32" ? promisify(realpath) : realpathNative;

/** Resolve symlinks, retaining the original spelling when the target cannot be resolved. */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export async function canonicalizePathAsync(path: string): Promise<string> {
	try {
		return await realpathAsync(path);
	} catch {
		return path;
	}
}

/** Cache project identities for one lookup; missing paths retain their exact stored spelling. */
export function createSessionCwdMatcher(cwd: string): (candidate: string | undefined) => boolean {
	const expected = canonicalizePath(cwd);
	const resolved = new Map<string, string>([[cwd, expected]]);
	return (candidate) => {
		if (candidate === undefined) return false;
		let path = resolved.get(candidate);
		if (path === undefined) {
			path = canonicalizePath(candidate);
			resolved.set(candidate, path);
		}
		return path === expected;
	};
}

export function createSessionCwdMatcherAsync(cwd: string): (candidate: string | undefined) => Promise<boolean> {
	const resolved = new Map<string, Promise<string>>();
	const resolveCached = (target: string): Promise<string> => {
		let pending = resolved.get(target);
		if (pending === undefined) {
			pending = canonicalizePathAsync(target);
			resolved.set(target, pending);
		}
		return pending;
	};
	return async (candidate) => {
		if (candidate === undefined) return false;
		const [expected, path] = await Promise.all([resolveCached(cwd), resolveCached(candidate)]);
		return path === expected;
	};
}
