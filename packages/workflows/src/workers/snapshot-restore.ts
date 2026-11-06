import {
	isGitUnavailableError,
	type RestoredWorktree,
	type RestoreWorktreeSnapshotOptions,
	restoreWorktree,
	type SnapshotBlobStore,
	type WorktreeSnapshot,
} from "@bastani/atomic";
import { WorkspaceRestoreUnavailableError, workspaceBindingIdentity } from "./placement-errors.js";
import type { WorkerHostGit } from "./worker-host-types.js";
import type { WorkspaceBinding, WorkspaceRestore } from "./workspace-binding.js";

/** Bindings whose recorded snapshots the snapshot restore remembers, before it forgets them all. */
const RECORDED_SNAPSHOT_ENTRIES = 256;

export interface SnapshotRestoreOptions {
	/** The worktree snapshots the shared journal recorded with a binding's tree and head, oldest first. */
	readonly recorded: (binding: WorkspaceBinding) => Promise<readonly WorktreeSnapshot[]>;
	/** The shared journal's snapshot blobs: the patches and bundles of uncommitted and unpushed content. */
	readonly blobs: SnapshotBlobStore | undefined;
	/** Where the host keeps its object stores and the worktrees it restores. */
	readonly storeDir: string;
	/** The git the host runs, with its environment: every Git command of a restore runs it, and nothing resolves one. */
	readonly git: WorkerHostGit;
	/** Internal, tests only: what restores a binding or a snapshot instead of `restoreWorktree`. */
	readonly restore?: (
		target: WorkspaceBinding | WorktreeSnapshot,
		options: RestoreWorktreeSnapshotOptions,
	) => Promise<Pick<RestoredWorktree, "path">>;
}

/**
 * The restore port of a worker host that was given none (#4416): #4245's `restoreWorktree` with the host's git of the
 * snapshot the work carries, which its root captured as it dispatched the work (#4492), or else of the binding, from
 * the worktree snapshots the shared journal recorded with its tree and head, so a binding with uncommitted content
 * restores too; resolves the verified worktree's path. It never resolves or downloads a git. The recorded snapshots of
 * a binding that restored are read once, and never for work that carries a snapshot. A restore that cannot run on this
 * host, because its git does not run, is refused with a {@link WorkspaceRestoreUnavailableError} (`no-restore-port`);
 * any other failure rejects with its own error.
 */
export function snapshotRestore(options: SnapshotRestoreOptions): WorkspaceRestore {
	const restore = options.restore ?? restoreWorktree;
	const restored = new Map<string, readonly WorktreeSnapshot[]>();
	const restoreOnHost = async (
		binding: WorkspaceBinding,
		target: WorkspaceBinding | WorktreeSnapshot,
		recorded: Pick<RestoreWorktreeSnapshotOptions, "snapshots">,
		signal: AbortSignal,
	): Promise<string> => {
		try {
			return (
				await restore(target, {
					...recorded,
					blobs: options.blobs,
					storeDir: options.storeDir,
					signal,
					git: options.git,
				})
			).path;
		} catch (error) {
			if (signal.aborted || !isGitUnavailableError(error)) throw error;
			throw new WorkspaceRestoreUnavailableError("no-restore-port", workspaceBindingIdentity(binding), {
				cause: error,
			});
		}
	};
	return async (binding, { signal, snapshot }) => {
		if (snapshot !== undefined) return restoreOnHost(binding, snapshot, {}, signal);
		const key = JSON.stringify([binding.head, binding.tree]);
		const snapshots = restored.get(key) ?? (await options.recorded(binding));
		let path: string;
		try {
			path = await restoreOnHost(binding, binding, { snapshots }, signal);
		} catch (error) {
			restored.delete(key);
			throw error;
		}
		if (!restored.has(key) && restored.size >= RECORDED_SNAPSHOT_ENTRIES) restored.clear();
		restored.set(key, snapshots);
		return path;
	};
}
