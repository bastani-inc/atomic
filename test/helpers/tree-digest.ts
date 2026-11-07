import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every file below `directory` except Git's own metadata, as its path relative to `directory` (with `/` separators) and
 * the SHA-256 of its bytes, in path order. Two checkouts with the same digest hold the same working tree: tracked,
 * modified and untracked files alike.
 */
export function treeDigest(directory: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else
				files[relative(directory, path).split(sep).join("/")] = createHash("sha256")
					.update(readFileSync(path))
					.digest("hex");
		}
	};
	walk(directory);
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
