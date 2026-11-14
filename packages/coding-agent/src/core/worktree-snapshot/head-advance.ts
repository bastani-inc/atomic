import type { WorkspaceDriftError } from "./errors.ts";
import { runGit } from "./git.ts";
import { unshallowRestoredWorktree } from "./restore.ts";

/**
 * Whether `drift` only moved HEAD forward over the recorded content: the checkout's tree equals the recorded tree and
 * the recorded HEAD is an ancestor of the current one, as after committing the recorded edits. Resume continues in
 * place for such a drift. Any other drift, including a HEAD whose ancestry Git cannot establish, is not. In a restored
 * worktree whose store a depth-1 fetch left shallow, the store's history is fetched before the answer is no (#4748).
 */
export async function isHeadOnlyAdvance(drift: WorkspaceDriftError, signal?: AbortSignal): Promise<boolean> {
	if (drift.actualTree !== drift.expectedTree || drift.actualHead === null) return false;
	const isAncestor = async () =>
		(
			await runGit(["merge-base", "--is-ancestor", drift.expectedHead, drift.actualHead!], {
				cwd: drift.root,
				signal,
				allowExitCodes: [1, 128],
			})
		).exitCode === 0;
	if (await isAncestor()) return true;
	return (await unshallowRestoredWorktree(drift.root, [drift.expectedHead], signal)) && (await isAncestor());
}
