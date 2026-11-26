import * as blobStore from "./blob-store.ts";

/**
 * `installSharedHistorySnapshotIndex` of `blob-store.ts`, which the copies of that module earlier releases loaded lack.
 * A process that loaded such a copy before an in-place update replaced the installation keeps it, and can load the
 * modules that use this from the update: a named import of it would fail to link there, so they take it from here, a
 * path no earlier release has (#6560). Without it, the switch to shared-history forks leaves the fork links trigger to
 * the snapshot index's next open, which installs it then.
 */
const sharedHistory: Partial<Pick<typeof blobStore, "installSharedHistorySnapshotIndex">> = blobStore;

export const installSharedHistorySnapshotIndex: typeof blobStore.installSharedHistorySnapshotIndex =
	sharedHistory.installSharedHistorySnapshotIndex ?? (async () => {});
