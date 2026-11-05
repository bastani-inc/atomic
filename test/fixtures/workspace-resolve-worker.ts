/**
 * Chaos fixture: one process binding, restoring or locking a workspace. Prints one JSON line with the worktree or the
 * typed failure.
 *
 *   bind <repo> <branch>           resolve the workspace
 *   restore <binding.json>         restore a recorded binding
 *   hold-lock <git common dir>     take the repository lock, print "locked", and hold it until killed
 */
import { readFileSync } from "node:fs";
import { resolveWorkspace, restoreWorkspace, workspace } from "../../packages/coding-agent/src/core/workspace/index.ts";
import { withRepositoryLock } from "../../packages/coding-agent/src/core/workspace/lease.ts";

const [mode, first, second] = process.argv.slice(2);
try {
	if (mode === "bind" && first !== undefined && second !== undefined) {
		const binding = await resolveWorkspace(workspace({ repo: first, branch: second }));
		process.stdout.write(
			`${JSON.stringify({ outcome: "bound", worktree: binding.worktree, head: binding.head, tree: binding.tree })}\n`,
		);
	} else if (mode === "restore" && first !== undefined) {
		const worktree = await restoreWorkspace(JSON.parse(readFileSync(first, "utf-8")));
		process.stdout.write(`${JSON.stringify({ outcome: "bound", worktree })}\n`);
	} else if (mode === "hold-lock" && first !== undefined) {
		await withRepositoryLock(first, async () => {
			process.stdout.write(`${JSON.stringify({ outcome: "locked" })}\n`);
			await new Promise(() => {});
		});
	} else throw new Error("usage: workspace-resolve-worker bind <repo> <branch> | restore <binding.json> | hold-lock <dir>");
} catch (error) {
	const typed = error as { readonly name?: string; readonly code?: string; readonly message?: string };
	process.stdout.write(`${JSON.stringify({ outcome: "failed", name: typed.name, code: typed.code, message: typed.message })}\n`);
}
