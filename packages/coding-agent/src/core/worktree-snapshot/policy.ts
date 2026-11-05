import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { unreadablePathError } from "./errors.ts";

/** Built-in patterns, in `.gitignore` syntax, for files that commonly hold credentials. Nothing un-denies them. */
export const SNAPSHOT_DENY_PATTERNS: readonly string[] = Object.freeze([
	".env*",
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

/**
 * SSH key files, matched apart from the always-denied list: any `id_*` file without an extension, and any file named
 * after an `ssh-keygen` key type (`id_rsa`, `id_ed25519`, and so on) whatever its suffix, such as a backup, except the
 * public keys and certificates that end in `.pub`. Other `id_*` files with an extension, such as `id_utils.ts`, are
 * not key files.
 */
export const SNAPSHOT_KEY_FILE_PATTERNS: readonly string[] = Object.freeze([
	"id_*",
	"!id_*.*",
	"id_dsa*",
	"id_ecdsa*",
	"id_ed25519*",
	"id_mldsa*",
	"id_rsa*",
	"id_xmss*",
	"!id_*.pub",
]);

export const SNAPSHOT_IGNORE_FILE = ".atomic/snapshot-ignore";

export type PathExclusion = "denied" | "snapshot-ignore";

export interface SnapshotPathPolicy {
	exclusion(path: string): PathExclusion | undefined;
}

const alwaysDenied = ignore().add([...SNAPSHOT_DENY_PATTERNS]);
const keyFiles = ignore().add([...SNAPSHOT_KEY_FILE_PATTERNS]);

export function isDeniedSnapshotPath(path: string): boolean {
	return alwaysDenied.ignores(path) || keyFiles.ignores(path);
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
			if (isDeniedSnapshotPath(path)) return "denied";
			if (projectIgnore?.ignores(path)) return "snapshot-ignore";
			return undefined;
		},
	};
}
