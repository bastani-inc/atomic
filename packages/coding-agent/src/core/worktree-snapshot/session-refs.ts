import { existsSync } from "node:fs";
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
const SESSION_SNAPSHOT_REFS = "refs/atomic/snapshots";

function sessionRefsPrefix(sessionId: string): string {
	return `${SESSION_SNAPSHOT_REFS}/${sessionId}/`;
}

/** The ref that keeps the latest snapshot session `sessionId` recorded of the checkout at `root`. */
export function sessionSnapshotRef(sessionId: string, root: string): string {
	return `${sessionRefsPrefix(sessionId)}${sha256Hex(canonicalizeWorktreePath(root)).slice(0, 24)}`;
}

/**
 * Points the session's ref for the checkout at `root` to `commit`. Resolves false, changing nothing, when the
 * repository does not hold `commit` or Git rejects the session id as a ref name.
 */
export async function keepSessionSnapshotCommit(sessionId: string, root: string, commit: string): Promise<boolean> {
	const { exitCode } = await runGit(["update-ref", sessionSnapshotRef(sessionId, root), commit], {
		cwd: root,
		allowExitCodes: [128],
	});
	return exitCode === 0;
}

/**
 * Deletes the refs that keep session `sessionId`'s snapshot commits in the repository of each of `roots`: only the
 * ref of that checkout, or with `everyCheckout` every ref of the session there. A root that is gone or not a
 * repository, or Git that cannot run, is skipped; a failure goes to the debug log. Never throws.
 */
export async function releaseSessionSnapshotRefs(
	sessionId: string,
	roots: Iterable<string>,
	everyCheckout = false,
): Promise<void> {
	for (const root of roots) {
		try {
			if (!existsSync(root)) continue;
			const pattern = everyCheckout ? sessionRefsPrefix(sessionId) : sessionSnapshotRef(sessionId, root);
			const listed = await runGit(["for-each-ref", "--format=%(refname)", pattern], {
				cwd: root,
				allowExitCodes: [128],
			});
			const refs = listed.stdout.toString("utf8").split("\n").filter(Boolean);
			if (listed.exitCode !== 0 || refs.length === 0) continue;
			await runGit(["update-ref", "--stdin"], {
				cwd: root,
				input: refs.map((ref) => `delete ${ref}\n`).join(""),
			});
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
		const listed = await runGit(["for-each-ref", "--format=%(refname)", sessionSnapshotRef(sessionId, root)], {
			cwd: root,
			signal,
			allowExitCodes: [128],
		});
		if (listed.exitCode !== 0 || listed.stdout.toString("utf8").trim() === "") return false;
		const { remotes } = await readRepositoryConfig(root, signal);
		return repositoryIdsOf(snapshot.remotes).includes(repositoryIdOf(remotes));
	} catch (error) {
		if (isGitUnavailableError(error)) return false;
		throw error;
	}
}
