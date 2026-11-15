import { isGitUnavailableError } from "../../utils/git-errors.ts";
import { failureDebugFields, reportDebug } from "../debug.ts";
import { readRepositoryConfig } from "./capture.ts";
import { sha256Hex } from "./env-hash.ts";
import { runGit } from "./git.ts";
import { canonicalizeWorktreePath } from "./paths.ts";
import { repositoryIdOf, repositoryIdsOf } from "./repository-identity.ts";
import type { WorktreeSnapshot } from "./types.ts";

/**
 * Where a checkout's repository keeps the commit of the latest snapshot each session recorded of it (#4923):
 * `refs/atomic/snapshots/<sessionId>/<checkout>`, one ref per session and checkout, so `git gc` keeps the commit and
 * resume still recognises the checkout the session worked in. The namespace is outside `refs/heads` and `refs/tags`,
 * so `git push`, `git push --all` and `git push --tags` never send it.
 */
function sessionSnapshotRef(sessionId: string, root: string): string {
	return `refs/atomic/snapshots/${sessionId}/${sha256Hex(canonicalizeWorktreePath(root)).slice(0, 24)}`;
}

/**
 * Points the session's ref for the checkout at `root` to `commit`. Changes nothing when the repository no longer
 * holds `commit`, as for the snapshot of an unchanged capture that `git gc` pruned, or Git rejects the session id
 * as a ref name.
 */
export async function keepSessionSnapshotCommit(sessionId: string, root: string, commit: string): Promise<void> {
	await runGit(["update-ref", sessionSnapshotRef(sessionId, root), commit], { cwd: root, allowExitCodes: [128] });
}

/**
 * Deletes the ref that keeps session `sessionId`'s snapshot commit of each of `roots` in that checkout's repository.
 * A root that is gone or not a repository, or Git that cannot run, is skipped, with the reason in the debug log.
 * Never throws.
 */
export async function releaseSessionSnapshotRefs(sessionId: string, roots: Iterable<string>): Promise<void> {
	for (const root of roots) {
		try {
			await runGit(["update-ref", "-d", sessionSnapshotRef(sessionId, root)], { cwd: root });
		} catch (error) {
			reportDebug("storage", "snapshot-ref-release-failed", { root, ...failureDebugFields(error) });
		}
	}
}

/**
 * Whether the repository of the checkout at `root` keeps a snapshot commit of session `sessionId` for that checkout,
 * whichever snapshot it is, and names the repository `snapshot` recorded. Only a capture of the session in this
 * checkout writes the ref, so it tells the checkout the session worked in from another clone at the same path even
 * after the snapshot's own commit is gone. A checkout that is not a repository, or a node without Git, does not.
 */
export async function holdsSessionSnapshotRef(
	sessionId: string,
	snapshot: Pick<WorktreeSnapshot, "remotes">,
	root: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const { exitCode } = await runGit(["show-ref", "--verify", "--quiet", sessionSnapshotRef(sessionId, root)], {
			cwd: root,
			signal,
			allowExitCodes: [1, 128],
		});
		if (exitCode !== 0) return false;
		const { remotes } = await readRepositoryConfig(root, signal);
		return repositoryIdsOf(snapshot.remotes).includes(repositoryIdOf(remotes));
	} catch (error) {
		if (isGitUnavailableError(error)) return false;
		throw error;
	}
}
