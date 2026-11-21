import { isGitUnavailableError } from "../../utils/git-errors.ts";
import { failureDebugFields, reportDebugAsync as reportDebug } from "../debug.ts";
import { readRepositoryConfig } from "./capture.ts";
import { sha256Hex } from "./env-hash.ts";
import { runGit } from "./git.ts";
import { canonicalizeWorktreePathAsync } from "./paths.ts";
import { repositoryIdOf, repositoryIdsOf } from "./repository-identity.ts";
import type { WorktreeSnapshot } from "./types.ts";

/**
 * Where a checkout's repository keeps the commit of the latest snapshot each session recorded of it (#4923):
 * `refs/atomic/snapshots/<sessionId>/<checkout>`, one ref per session and checkout, so `git gc` keeps the commit and
 * resume still recognises the checkout the session worked in. The namespace is outside `refs/heads` and `refs/tags`,
 * so `git push`, `git push --all` and `git push --tags` never send it.
 */
function sessionSnapshotRef(sessionId: string, canonicalRoot: string): string {
	return `refs/atomic/snapshots/${sessionId}/${sha256Hex(canonicalRoot).slice(0, 24)}`;
}

/**
 * What this process last made of each session ref, by checkout and ref: the commit it wrote, or null once it deleted
 * the ref. Only captures of the session in that checkout write the ref and only this session's process holds it, so
 * the turns of a checkout that did not change, which keep the same commit, write nothing.
 */
const writtenRefs = new Map<string, string | null>();

/** Whether pointing a ref to `commit` must run Git, given the commit this process last wrote to it (null: deleted). */
function refWriteNeeded(last: string | null | undefined, commit: string): boolean {
	return last !== commit;
}

/** Whether deleting a ref must run Git, given what this process last made of it. */
function refDeletionNeeded(last: string | null | undefined): boolean {
	return last !== null;
}

function writtenRefKey(canonicalRoot: string, ref: string): string {
	return `${canonicalRoot}\0${ref}`;
}

/**
 * Points the session's ref for the checkout at `root` to `commit`. Changes nothing when the repository no longer
 * holds `commit`, as for the snapshot of an unchanged capture that `git gc` pruned, or Git rejects the session id
 * as a ref name, and runs no Git when this process already pointed the ref to `commit`.
 */
export async function keepSessionSnapshotCommit(sessionId: string, root: string, commit: string): Promise<void> {
	const canonicalRoot = await canonicalizeWorktreePathAsync(root);
	const ref = sessionSnapshotRef(sessionId, canonicalRoot);
	const key = writtenRefKey(canonicalRoot, ref);
	if (!refWriteNeeded(writtenRefs.get(key), commit)) return;
	writtenRefs.delete(key);
	const { exitCode } = await runGit(["update-ref", ref, commit], { cwd: root, allowExitCodes: [128] });
	if (exitCode === 0) writtenRefs.set(key, commit);
}

/**
 * Deletes the ref that keeps session `sessionId`'s snapshot commit of each of `roots` in that checkout's repository,
 * unless this process already deleted it since it last wrote it. A root that is gone or not a repository, or Git that
 * cannot run, is skipped, with the reason in the debug log. Never throws.
 */
export async function releaseSessionSnapshotRefs(sessionId: string, roots: Iterable<string>): Promise<void> {
	for (const root of roots) {
		try {
			const canonicalRoot = await canonicalizeWorktreePathAsync(root);
			const ref = sessionSnapshotRef(sessionId, canonicalRoot);
			const key = writtenRefKey(canonicalRoot, ref);
			if (!refDeletionNeeded(writtenRefs.get(key))) continue;
			writtenRefs.delete(key);
			await runGit(["update-ref", "-d", ref], { cwd: root });
			writtenRefs.set(key, null);
		} catch (error) {
			reportDebug("storage", "snapshot-ref-release-failed", { root, ...failureDebugFields(error) });
		}
	}
}

/**
 * Deletes the ref that keeps session `sessionId`'s snapshot commit of each of `roots`, as {@link
 * releaseSessionSnapshotRefs} does, for a session whose refs are gone for good with the session that launched it: this
 * process keeps nothing of them afterwards. Never throws.
 */
export async function retireSessionSnapshotRefs(sessionId: string, roots: Iterable<string>): Promise<void> {
	for (const root of roots) {
		try {
			const canonicalRoot = await canonicalizeWorktreePathAsync(root);
			const ref = sessionSnapshotRef(sessionId, canonicalRoot);
			writtenRefs.delete(writtenRefKey(canonicalRoot, ref));
			await runGit(["update-ref", "-d", ref], { cwd: root });
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
		const ref = sessionSnapshotRef(sessionId, await canonicalizeWorktreePathAsync(root));
		const { exitCode } = await runGit(["rev-parse", "--verify", "--quiet", ref], {
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
