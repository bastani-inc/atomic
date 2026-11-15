import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withScratchDirectory, writeSnapshotCommit } from "./capture.ts";
import { isGitUnavailableError, isWorkspaceError } from "./errors.ts";
import { type GitRunOptions, nulFields, runGit } from "./git.ts";
import { storeSnapshotTree } from "./restore.ts";
import type { SnapshotBlobStore, WorktreeDegradedWork, WorktreeSnapshot } from "./types.ts";

/** Where a restore keeps work it could not carry over, one ref per snapshot of the partly restored worktree. */
export const DEGRADED_WORK_REFS = "refs/atomic/degraded-work/";

export interface CarryOverDegradedWorkOptions {
	/** The worktree a full restore of the pinned snapshot just wrote. */
	readonly worktree: string;
	/** The latest snapshot of the partly restored worktree. */
	readonly work: WorktreeSnapshot;
	/** The tree the partial restore wrote, which the work started from; undefined when the session never recorded it. */
	readonly base: string | undefined;
	readonly blobs?: SnapshotBlobStore;
	readonly storeDir?: string;
	readonly signal?: AbortSignal;
}

/**
 * Puts the work a session did in a partly restored worktree on top of a full restore of the snapshot it lacked (#4922),
 * whole or not at all: the changes from the tree the partial restore wrote to the work's latest snapshot. When they do
 * not apply, nothing in the worktree changes and a ref of the worktree's object store keeps them as a commit. When the
 * work's snapshot cannot be read here, nothing changes either. Rejects only with a failure that is not a typed workspace
 * or Git failure, or once `signal` aborted.
 */
export async function carryOverDegradedWork(options: CarryOverDegradedWorkOptions): Promise<WorktreeDegradedWork> {
	const { work, base, signal } = options;
	const outcome = (fields: Omit<WorktreeDegradedWork, "snapshotId" | "root">): WorktreeDegradedWork => ({
		snapshotId: work.id,
		root: work.root,
		...fields,
	});
	if (base === undefined) {
		return outcome({
			outcome: "unavailable",
			paths: [],
			reason: "the session holds no record of the partial restore",
		});
	}
	try {
		const store = await storeSnapshotTree(work, { blobs: options.blobs, storeDir: options.storeDir, signal });
		const git: GitRunOptions = { cwd: options.worktree, signal, env: { GIT_DIR: store } };
		const present = await runGit(["cat-file", "-e", `${base}^{tree}`], { ...git, allowExitCodes: [1, 128] });
		if (present.exitCode !== 0) {
			return outcome({
				outcome: "unavailable",
				paths: [],
				reason: `the tree it started from, ${base}, is not here`,
			});
		}
		const changed = ["diff-tree", "-r", "--no-renames", "--no-ext-diff", "--ignore-submodules=none"];
		const paths = nulFields((await runGit([...changed, "--name-only", "-z", base, work.tree], git)).stdout);
		const patch = (
			await runGit([...changed, "-p", "--binary", "--full-index", "--no-textconv", base, work.tree], git)
		).stdout;
		return await withScratchDirectory(async (scratch) => {
			const file = join(scratch, "degraded-work.patch");
			await writeFile(file, patch);
			const apply = ["apply", "--binary", "--whitespace=nowarn", "--no-ignore-whitespace"];
			// The worktree's own repository applies the work: its files, never the object store's.
			const worktree: GitRunOptions = { cwd: options.worktree, signal };
			const check = await runGit([...apply, "--check", file], { ...worktree, allowExitCodes: [1, 128] });
			if (check.exitCode === 0) {
				await runGit([...apply, file], worktree);
				return outcome({ outcome: "applied", paths });
			}
			const commit = await writeSnapshotCommit(git, work.head, work.tree);
			const ref = `${DEGRADED_WORK_REFS}${work.id}`;
			await runGit(["update-ref", ref, commit], git);
			return outcome({ outcome: "kept", paths, base, commit, ref });
		});
	} catch (error) {
		if (signal?.aborted || !(isWorkspaceError(error) || isGitUnavailableError(error))) throw error;
		return outcome({ outcome: "unavailable", paths: [], reason: error.message });
	}
}
