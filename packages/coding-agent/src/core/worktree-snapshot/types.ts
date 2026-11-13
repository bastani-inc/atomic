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
	/** Delete unreferenced snapshot blobs automatically when a session closes or a root workflow run finishes. Default true. */
	readonly autoCollect: boolean;
	/** Shortest time between two automatic collections of one database, in seconds, on the database's clock. Default 3600. */
	readonly collectIntervalSeconds: number;
	/** Blobs stored or re-stored less than this many seconds ago are never collected. 0 turns the protection off. Default 3600. */
	readonly graceSeconds: number;
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
	/** Stores each blob once. Storing a hash that exists keeps its bytes and restarts its age, which protects it from collection. */
	putBlobs(blobs: readonly SnapshotBlob[]): Promise<void>;
	getBlob(hash: string): Promise<Uint8Array | undefined>;
	/**
	 * Restarts the age of each stored hash, as storing it again would, without its bytes. Resolves false when any is
	 * missing. Capture calls it before reusing an earlier snapshot's blobs, so collection keeps them until the new
	 * snapshot that references them is published.
	 */
	refreshBlobs(hashes: readonly string[]): Promise<boolean>;
	/** Every stored hash. */
	listBlobHashes(): Promise<readonly string[]>;
}

/** Restore-time notices that never block a verified restore. */
export type WorktreeRestoreWarning =
	| { readonly code: "omitted-content"; readonly omitted: readonly WorktreeSnapshotOmission[] }
	| { readonly code: "filters"; readonly filters: WorktreeSnapshotFilters }
	| { readonly code: "lfs-objects-unavailable"; readonly paths: readonly string[] }
	| {
			readonly code: "stale-restore-retained";
			readonly path: string;
			/** What was left: a staging or nested worktree, a crash record file, or the crash-record directory itself. */
			readonly kind: "worktree" | "record" | "records-directory";
	  };

/** Which commit a restore that could not reach a snapshot's recorded `HEAD` checked out instead. */
export type WorktreeDegradedRestoreBasis = "pushed-base" | "earlier-snapshot" | "branch-tip";

/**
 * What a restore that could not reproduce its snapshot exactly restored instead (#4733): the recorded `HEAD` with the
 * change sets of the patch chain that could be applied (`partial-changes`), or the closest commit it could fetch, with
 * none of the snapshot's changes (`closest-commit`).
 */
export interface WorktreeDegradedRestore {
	readonly stage: "partial-changes" | "closest-commit";
	/** The commit the worktree has checked out. */
	readonly head: string;
	/** The Git tree of the worktree's content when it was restored. */
	readonly tree: string;
	/** With `closest-commit`, where `head` came from. */
	readonly basis?: WorktreeDegradedRestoreBasis;
	/** Indexes of the patch chain's change sets that are not in the worktree. */
	readonly missingLinks: readonly number[];
	/** Paths those change sets touch, where their content was available to list them. */
	readonly missingPaths: readonly string[];
	/** Recorded commits that are not in the worktree. */
	readonly missingCommits: readonly string[];
	/** The code of the restore error that kept the exact state from being restored, and its reason when it has one. */
	readonly cause: string;
	readonly causeReason?: string;
	/** What to do to get the rest: the restore error's hint. */
	readonly hint: string;
}

/** A checkout restored on this host in place of one recorded elsewhere: work under `from` now happens under `to`. */
export interface WorktreeRootMapping {
	readonly from: string;
	readonly to: string;
	readonly snapshotId: string;
	readonly tree: string;
	readonly restoredAt: string;
	/** Present when `to` holds less than the snapshot: what it holds and what is missing (#4733). */
	readonly degraded?: WorktreeDegradedRestore;
}

/**
 * A checkout a resume continued without (#4733): nothing of its snapshot could be restored on this host, so the
 * session went on in `continuedIn`, as it was.
 */
export interface WorktreeUnrestored {
	readonly snapshotId: string;
	readonly continuedIn: string;
	/** Whether `continuedIn` is the session's recorded working directory, or the directory the resume started in. */
	readonly place: "recorded" | "launch";
	readonly cause: string;
	readonly causeReason?: string;
	readonly detail: string;
	readonly hint: string;
	readonly at: string;
}
