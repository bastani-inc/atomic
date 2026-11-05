/** Chaos fixture: one process binding a workspace. Prints one JSON line with the worktree or the typed failure. */
import { resolveWorkspace, workspace } from "../../packages/coding-agent/src/core/workspace/index.ts";

const [repo, branch] = process.argv.slice(2);
if (repo === undefined || branch === undefined) throw new Error("usage: workspace-resolve-worker <repo> <branch>");
try {
	const binding = await resolveWorkspace(workspace({ repo, branch }));
	process.stdout.write(`${JSON.stringify({ outcome: "bound", worktree: binding.worktree })}\n`);
} catch (error) {
	const typed = error as { readonly name?: string; readonly code?: string; readonly message?: string };
	process.stdout.write(`${JSON.stringify({ outcome: "failed", name: typed.name, code: typed.code, message: typed.message })}\n`);
}
