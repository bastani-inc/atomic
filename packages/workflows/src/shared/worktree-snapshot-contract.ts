import type { WorktreeSnapshot } from "@bastani/atomic";

/** A recoverable worktree boundary, in its root workflow journal's sequence order. */
export interface WorkflowSnapshotBoundary {
	readonly seq: number;
	readonly kind: "tool" | "stage";
	readonly checkpointId: string;
	readonly root: string;
	readonly snapshot: WorktreeSnapshot;
}
