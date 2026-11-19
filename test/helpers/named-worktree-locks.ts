import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Advisory-lock namespace for these repositories, each in its own writable sandbox. */
export function namedWorktreeLockDir(repo: string): string {
	const common = realpathSync(join(repo, ".git"));
	const key = createHash("sha256")
		.update(process.platform === "win32" ? common.toLowerCase() : common)
		.digest("hex");
	return join(dirname(repo), `.atomic-worktree-locks-${key}`);
}
