import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { unreadablePathError } from "./errors.ts";

/**
 * Built-in patterns, in `.gitignore` syntax, for files that commonly hold credentials. The last matching pattern
 * decides, so the key-file extensions come after the negation that keeps `id_*` files with an extension, such as
 * `id_rsa.pub` or `id_utils.ts`.
 */
export const SNAPSHOT_DENY_PATTERNS: readonly string[] = Object.freeze([
	".env*",
	"id_*",
	"!id_*.*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"credentials",
	"credentials.json",
	".netrc",
	"_netrc",
	".git-credentials",
	".pgpass",
]);

export const SNAPSHOT_IGNORE_FILE = ".atomic/snapshot-ignore";

export type PathExclusion = "denied" | "snapshot-ignore";

export interface SnapshotPathPolicy {
	exclusion(path: string): PathExclusion | undefined;
}

const denied = ignore().add([...SNAPSHOT_DENY_PATTERNS]);

export function isDeniedSnapshotPath(path: string): boolean {
	return denied.ignores(path);
}

/** The deny list plus the repository's `.atomic/snapshot-ignore`, matched against root-relative paths. */
export async function loadSnapshotPathPolicy(root: string): Promise<SnapshotPathPolicy> {
	let projectIgnore: Ignore | undefined;
	try {
		projectIgnore = ignore().add(await readFile(join(root, SNAPSHOT_IGNORE_FILE), "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw unreadablePathError(join(root, SNAPSHOT_IGNORE_FILE), error);
	}
	return {
		exclusion(path) {
			if (denied.ignores(path)) return "denied";
			if (projectIgnore?.ignores(path)) return "snapshot-ignore";
			return undefined;
		},
	};
}
