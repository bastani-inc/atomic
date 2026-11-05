import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Built-in patterns, in `.gitignore` syntax, for files that commonly hold credentials. */
export const SNAPSHOT_DENY_PATTERNS: readonly string[] = Object.freeze([
	".env*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_*",
	"!id_*.*",
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
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return {
		exclusion(path) {
			if (denied.ignores(path)) return "denied";
			if (projectIgnore?.ignores(path)) return "snapshot-ignore";
			return undefined;
		},
	};
}
