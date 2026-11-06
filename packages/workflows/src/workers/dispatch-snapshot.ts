import {
	captureWorktreeSnapshot,
	isWorkspaceGitError,
	type SnapshotBlobStore,
	snapshotBlobHashes,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
	type WorktreeSnapshotSettingsInput,
} from "@bastani/atomic";

/** Worktrees whose last snapshot is kept as the base of their next capture, before all of them are forgotten. */
const REMEMBERED_WORKTREES = 256;

/**
 * How often, at most, the root restarts the age of the blobs its waiting children's snapshots reference. Collection
 * keeps an unreferenced blob for its grace window (`snapshots.graceSeconds`, an hour by default), and no recorded
 * checkpoint references a snapshot that work carries.
 */
export const CARRIED_SNAPSHOT_REFRESH_MS = 5 * 60_000;

export interface DispatchSnapshotsOptions {
	/** The shared journal's snapshot blobs: each capture stores its patches and bundle there before its work is queued. */
	readonly blobs: SnapshotBlobStore | undefined;
	/** Receives the typed reason a worktree could not be captured; its work is queued without a snapshot. */
	readonly unavailable: (reason: Error) => void;
	/** Internal, tests only: the refresh interval in place of {@link CARRIED_SNAPSHOT_REFRESH_MS}. */
	readonly refreshMs?: number;
	/** Internal, tests only: what captures a worktree in place of `captureWorktreeSnapshot`. */
	readonly capture?: typeof captureWorktreeSnapshot;
}

/**
 * The worktree snapshots a root with shared placement captures on its own host as it dispatches bound work (#4492): of
 * the worktree a child is bound to with `ctx.workflow(child, { workspace })`, and of the root's own binding when it
 * starts. The work carries the snapshot, so a worker host without the tree restores it, uncommitted and unpushed
 * content included. Captures of one worktree run one at a time, each based on the last, so a capture that finds
 * nothing changed reuses it. While work that carries a snapshot waits, the snapshot's blobs are kept from collection.
 */
export class DispatchSnapshots {
	private readonly latest = new Map<string, WorktreeSnapshot>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly carried = new Map<string, { readonly snapshot: WorktreeSnapshot; holders: number }>();
	private refreshedAt = Date.now();

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

	/** Keeps `snapshot`'s blobs from collection while the work that carries it waits; the returned function lets go. */
	carry(snapshot: WorktreeSnapshot | undefined): () => void {
		if (snapshot === undefined) return () => {};
		const entry = this.carried.get(snapshot.id) ?? { snapshot, holders: 0 };
		entry.holders++;
		this.carried.set(snapshot.id, entry);
		return () => {
			if (--entry.holders === 0) this.carried.delete(snapshot.id);
		};
	}

	/**
	 * Restarts the age of every blob a carried snapshot references, as storing it again would, once the refresh interval
	 * has passed since the last refresh, by `now` in milliseconds.
	 */
	async refresh(now: number): Promise<void> {
		const blobs = this.options.blobs;
		if (blobs === undefined || now - this.refreshedAt < (this.options.refreshMs ?? CARRIED_SNAPSHOT_REFRESH_MS))
			return;
		this.refreshedAt = now;
		const hashes = new Set([...this.carried.values()].flatMap(({ snapshot }) => snapshotBlobHashes(snapshot)));
		if (hashes.size > 0) await blobs.refreshBlobs([...hashes]);
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
