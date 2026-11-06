import {
	captureWorktreeSnapshot,
	isWorkspaceGitError,
	type SnapshotBlobStore,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
	type WorktreeSnapshotSettingsInput,
} from "@bastani/atomic";

/** Worktrees whose last snapshot is kept as the base of their next capture, before all of them are forgotten. */
const REMEMBERED_WORKTREES = 256;

export interface DispatchSnapshotsOptions {
	/** The shared journal's snapshot blobs: each capture stores its patches and bundle there before its work is queued. */
	readonly blobs: SnapshotBlobStore | undefined;
	/** Receives the typed reason a worktree could not be captured; its work is queued without a snapshot. */
	readonly unavailable: (reason: Error) => void;
	/** Internal, tests only: what captures a worktree in place of `captureWorktreeSnapshot`. */
	readonly capture?: typeof captureWorktreeSnapshot;
}

/**
 * The worktree snapshots a root with shared placement captures on its own host as it dispatches bound work (#4492): of
 * the worktree a child is bound to with `ctx.workflow(child, { workspace })`, and of the root's own binding when it
 * starts. The work carries the snapshot, so a worker host without the tree restores it, uncommitted and unpushed
 * content included. Captures of one worktree run one at a time, each based on the last, so a capture that finds
 * nothing changed reuses it. The queued work row, and the pool's record of the root's snapshot, reference the
 * snapshot's blobs in the journal's snapshot reference index, which keeps them from collection (#4503).
 */
export class DispatchSnapshots {
	private readonly latest = new Map<string, WorktreeSnapshot>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(private readonly options: DispatchSnapshotsOptions) {}

	/**
	 * The snapshot of the checkout at `worktree` as it is now, with its blobs stored, or undefined when snapshots are
	 * disabled or none can be captured: the reason, a Git, repository or blob store problem, goes to `unavailable`.
	 * Rejects with `signal`'s reason once it aborts, and with any failure that is not a workspace one.
	 */
	async capture(
		worktree: string,
		settings: WorktreeSnapshotSettingsInput | undefined,
		signal?: AbortSignal,
	): Promise<WorktreeSnapshot | undefined> {
		const blobs = this.options.blobs;
		if (blobs === undefined) {
			if (settings?.enabled !== false)
				this.options.unavailable(new WorkspaceSnapshotError("blob-store-unsupported", "workflow journal"));
			return undefined;
		}
		return this.serialized(worktree, async () => {
			signal?.throwIfAborted();
			let capture: WorktreeSnapshotCapture;
			try {
				capture = await (this.options.capture ?? captureWorktreeSnapshot)(worktree, {
					settings,
					previous: this.latest.get(worktree),
					blobs,
					signal,
				});
			} catch (error) {
				signal?.throwIfAborted();
				if (!isWorkspaceGitError(error)) throw error;
				this.options.unavailable(error);
				return undefined;
			}
			if (capture.status === "unavailable") this.options.unavailable(capture.reason);
			if (capture.status !== "captured" && capture.status !== "unchanged") return undefined;
			if (!this.latest.has(worktree) && this.latest.size >= REMEMBERED_WORKTREES) this.latest.clear();
			this.latest.set(worktree, capture.snapshot);
			return capture.snapshot;
		});
	}

	/** Runs `action` once every capture of `worktree` queued before it has settled. */
	private async serialized<T>(worktree: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(worktree);
		let release!: () => void;
		const settled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = (previous ?? Promise.resolve()).then(() => settled);
		this.queues.set(worktree, queued);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.queues.get(worktree) === queued) this.queues.delete(worktree);
		}
	}
}
