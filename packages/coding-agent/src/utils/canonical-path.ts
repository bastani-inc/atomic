import { realpathSync } from "node:fs";

/** Resolve symlinks, retaining the original spelling when the target cannot be resolved. */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
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
