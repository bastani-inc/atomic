import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalizePathAsync } from "./canonical-path.ts";

function canBatchCanonicalLeaf(path: string, parent: string, leaf: string): boolean {
	return (
		path.length > 0 &&
		parent !== path &&
		leaf.length > 0 &&
		leaf !== "." &&
		leaf !== ".." &&
		!path.endsWith("/") &&
		!path.endsWith("\\")
	);
}

/**
 * Returns a memoized per-batch async canonicalizer that resolves shared ancestor directories once via
 * `canonicalizePathAsync` (non-native `fs.realpath`) and verifies non-symlink leaves with a single `lstat`.
 * Any root, empty, relative-dot, trailing-slash, missing, or symlink leaf falls back to `canonicalizePathAsync`,
 * preserving exact `canonicalizePath` spelling on POSIX and Windows (including 8.3 short paths and junctions).
 */
export function createBatchedCanonicalizePathAsync(): (path: string) => Promise<string> {
	const dirCache = new Map<string, Promise<string>>();
	const resolveDir = (dir: string): Promise<string> => {
		let pending = dirCache.get(dir);
		if (pending === undefined) {
			const parent = dirname(dir);
			const leaf = basename(dir);
			if (!canBatchCanonicalLeaf(dir, parent, leaf)) {
				pending = canonicalizePathAsync(dir);
			} else {
				pending = (async () => {
					const realParent = await resolveDir(parent);
					const candidate = join(realParent, leaf);
					try {
						const st = await lstat(candidate);
						if (!st.isSymbolicLink()) return candidate;
					} catch {
						return canonicalizePathAsync(dir);
					}
					return canonicalizePathAsync(dir);
				})();
			}
			dirCache.set(dir, pending);
		}
		return pending;
	};
	return async (path: string): Promise<string> => {
		const parent = dirname(path);
		const leaf = basename(path);
		if (!canBatchCanonicalLeaf(path, parent, leaf)) {
			return canonicalizePathAsync(path);
		}
		const realParent = await resolveDir(parent);
		const candidate = join(realParent, leaf);
		try {
			const st = await lstat(candidate);
			if (!st.isSymbolicLink()) return candidate;
		} catch {
			return canonicalizePathAsync(path);
		}
		return canonicalizePathAsync(path);
	};
}
