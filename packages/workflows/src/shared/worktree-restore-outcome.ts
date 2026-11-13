/**
 * A checkout a run's resume, or the worker host that runs a pooled child, restored with less than its recorded
 * snapshot, or continued without (#4738). `message` is its one notice, which the run's stages are also told.
 */
export interface WorkflowWorktreeRestoreOutcome {
	/** The checkout's original recorded root. */
	readonly root: string;
	readonly snapshotId: string;
	readonly message: string;
	/** When the restore happened (ISO 8601). */
	readonly at: string;
	/** For a worktree restored with less than its snapshot: what it holds and what is missing. */
	readonly degraded?: import("@bastani/atomic").WorktreeDegradedRestore;
	/** For a checkout continued without: where the run continued, and why. */
	readonly unrestored?: import("@bastani/atomic").WorktreeUnrestored;
}
