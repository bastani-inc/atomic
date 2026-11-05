/**
 * The portable identity of a workspace: the remotes that hold its history, the commit it is based on, the Git tree of
 * its content, and a fingerprint of its dependency inputs. Schedulers and workspace providers consume this shape.
 */
export interface WorkspaceBinding {
	remotes: string[];
	head: string;
	tree: string;
	envHash: string;
}

/** Snapshot capture settings, from `snapshots.*` in settings.json, `createAgentSession`, or workflow run options. */
export interface WorktreeSnapshotSettings {
	/** Record snapshots at all. Default true. */
	readonly enabled: boolean;
	/** Capture untracked files that no ignore rule or deny pattern excludes. Default true. */
	readonly includeUntracked: boolean;
	/** Largest single file captured, in bytes. Default 5 MiB. */
	readonly maxFileBytes: number;
	/** Largest total of captured file content, patch chain and unpushed-commit bundle, in bytes. Default 50 MiB. */
	readonly maxSnapshotBytes: number;
	/** Record a full delta against `head` after this many incremental snapshots. Default 10. */
	readonly fullEvery: number;
}

export type WorktreeSnapshotPathOmissionReason = "denied" | "snapshot-ignore" | "untracked-excluded";
export type WorktreeSnapshotSizeOmissionReason = "over-file-cap" | "over-snapshot-cap";

/** Content a snapshot left out, and why. */
export type WorktreeSnapshotOmission =
	| { readonly reason: WorktreeSnapshotPathOmissionReason; readonly path: string }
	| { readonly reason: WorktreeSnapshotSizeOmissionReason; readonly path: string; readonly bytes: number }
	| {
			readonly reason: "unpushed-history-denied";
			readonly commits: readonly string[];
			readonly paths: readonly string[];
	  }
	| { readonly reason: "bundle-over-cap"; readonly commits: readonly string[]; readonly bytes: number };

export type WorktreeSnapshotOmissionReason = WorktreeSnapshotOmission["reason"];

/** One step of a patch chain: applying `patch` (a blob hash, or null for no change) produces `tree`. */
export interface WorktreeSnapshotChainLink {
	readonly tree: string;
	readonly patch: string | null;
	readonly bytes: number;
}

/** Conversion settings on the recording machine that can make a worktree's files differ from Git's stored content. */
export interface WorktreeSnapshotFilters {
	readonly autocrlf: string | null;
	readonly eol: string | null;
	/** Filter drivers that the repository's `.gitattributes` files name, such as `lfs`. */
	readonly drivers: readonly string[];
}

export interface WorktreeSnapshotBundle {
	/** Blob hash of a `git bundle` holding the commits reachable from `head` and from no remote-tracking ref. */
	readonly blob: string;
	readonly bytes: number;
	readonly commits: readonly string[];
}

/** The recorded state of one repository checkout. Every field is JSON. Blob hashes refer to a {@link SnapshotBlobStore}. */
export interface WorktreeSnapshot {
	readonly version: 1;
	/** Content-derived identity: equal ids mean equal reconstruction inputs. */
	readonly id: string;
	/** Absolute checkout root on the recording machine. Informational. */
	readonly root: string;
	readonly remotes: readonly string[];
	/** Current branch, or null when detached. */
	readonly branch: string | null;
	readonly head: string;
	/** Commit object for the full working tree, parented on `head`. Local to the recording machine. */
	readonly snapshot: string;
	readonly tree: string;
	readonly envHash: string;
	/** The newest link: a full delta against `head`, or an incremental one against the previous snapshot. */
	readonly delta: { readonly base: "head" | string; readonly patch: string | null; readonly bytes: number };
	/** Links from the latest full delta to this snapshot, in application order. Never longer than `fullEvery`. */
	readonly chain: readonly WorktreeSnapshotChainLink[];
	readonly bundle: WorktreeSnapshotBundle | null;
	readonly omitted: readonly WorktreeSnapshotOmission[];
	readonly filters: WorktreeSnapshotFilters | null;
	readonly capturedAt: string;
}

export interface SnapshotBlob {
	/** Lowercase hex SHA-256 of `data`. */
	readonly hash: string;
	readonly data: Uint8Array;
}

/** Content-addressed storage for snapshot patches and bundles, kept in the same storage as sessions or journals. */
export interface SnapshotBlobStore {
	/** Stores each blob once; storing a hash that exists is a no-op. */
	putBlobs(blobs: readonly SnapshotBlob[]): Promise<void>;
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	/** Every stored hash, for garbage collection. */
	listBlobHashes(): Promise<readonly string[]>;
	deleteBlobs(hashes: readonly string[]): Promise<void>;
}

/** Restore-time notices that never block a verified restore. */
export type WorktreeRestoreWarning =
	| { readonly code: "omitted-content"; readonly omitted: readonly WorktreeSnapshotOmission[] }
	| { readonly code: "filters"; readonly filters: WorktreeSnapshotFilters }
	| { readonly code: "lfs-objects-unavailable"; readonly paths: readonly string[] };
