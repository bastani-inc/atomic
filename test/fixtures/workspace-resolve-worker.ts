/**
 * Chaos fixture: one process binding, restoring or locking a workspace. Prints one JSON line with the worktree or the
 * typed failure.
 *
 *   bind <repo> <branch>           resolve the workspace
 *   restore <binding.json>         restore a recorded binding
 *   hold-lock <git common dir>     take the repository lock, print "locked", and hold it until killed
 *   wait-lock <git common dir> <ms> wait at most <ms> for the repository lock, print "locked" if it was taken
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
	} else if (mode === "wait-lock" && first !== undefined && second !== undefined) {
		await withRepositoryLock(first, async () => process.stdout.write(`${JSON.stringify({ outcome: "locked" })}\n`), Number(second));
	} else if (mode === "hold-lock" && first !== undefined) {
		await withRepositoryLock(first, async () => {
			process.stdout.write(`${JSON.stringify({ outcome: "locked" })}\n`);
			await new Promise(() => {});
		});
	} else
		throw new Error(
			"usage: workspace-resolve-worker bind <repo> <branch> | restore <binding.json> | hold-lock <dir> | wait-lock <dir> <ms>",
		);
} catch (error) {
	const typed = error as { readonly name?: string; readonly code?: string; readonly message?: string };
	process.stdout.write(
		`${JSON.stringify({ outcome: "failed", name: typed.name, code: typed.code, message: typed.message, fields: (error as { readonly fields?: unknown }).fields, causeName: ((error as { readonly cause?: { readonly name?: string } }).cause)?.name })}\n`,
	);
}
