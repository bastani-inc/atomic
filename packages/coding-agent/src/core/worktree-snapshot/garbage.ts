import { snapshotBlobHashes } from "./blob-store.ts";
import { WorkspaceConfigError } from "./errors.ts";
import type { SnapshotBlobStore, WorktreeSnapshot } from "./types.ts";

/**
 * How long an unreferenced blob is kept by default: one hour.
 *
 * A capture stores its blobs first and publishes the session entry or checkpoint that references them afterwards, so
 * for that gap a fresh blob is unreferenced. The gap is one capture plus one journal append, normally well under a
 * second, but a stopped or starved process can stretch it to minutes. An hour keeps every realistic gap safe, and the
 * cost of keeping an unreferenced blob that long is a few kilobytes of patch.
 */
export const DEFAULT_BLOB_GRACE_SECONDS = 3600;

export interface CollectSnapshotGarbageOptions {
	/** Blobs stored or re-stored less than this many seconds ago are never deleted. A non-negative integer; 0 disables the protection. Default {@link DEFAULT_BLOB_GRACE_SECONDS}. */
	readonly graceSeconds?: number;
}

/**
 * Deletes every stored blob that none of `retained` needs and that was last stored at least `graceSeconds` ago, and
 * resolves with the hashes it deleted. Callers pass the snapshots referenced by resumable checkpoints and the latest
 * snapshot of each session; each snapshot names its whole chain, so ancestors survive. When sessions and runs share
 * one database they share one blob table, so pass both sets together.
 *
 * Throws {@link WorkspaceConfigError} before reading the store when `graceSeconds` is not a non-negative integer.
 */
export async function collectSnapshotGarbage(
	store: SnapshotBlobStore,
	retained: Iterable<WorktreeSnapshot>,
	options: CollectSnapshotGarbageOptions = {},
): Promise<{ readonly deleted: readonly string[] }> {
	const graceSeconds = options.graceSeconds ?? DEFAULT_BLOB_GRACE_SECONDS;
	if (!Number.isInteger(graceSeconds) || graceSeconds < 0) {
		throw new WorkspaceConfigError("sdk", "graceSeconds", "a non-negative integer number of seconds");
	}
	const keep = new Set<string>();
	for (const snapshot of retained) for (const hash of snapshotBlobHashes(snapshot)) keep.add(hash);
	const candidates = (await store.listBlobHashes()).filter((hash) => !keep.has(hash));
	return { deleted: await store.deleteBlobs(candidates, { olderThanSeconds: graceSeconds }) };
}
