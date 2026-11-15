import type { PoolCheckpointMutation, PoolMutation } from "../durable/journal/pool-mutations.js";
import { checkpointKey, type PoolCommitReceipt } from "../durable/journal/sql-pool-queue.js";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { serializeJson } from "../durable/journal/values.js";
import { assertWorkflowSerializableObject } from "../shared/serializable.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import type { ShipShard } from "./ship-shard.js";

/**
 * Whether a host may keep `mutation` in its local journal and ship it later (#4768): a plain checkpoint, with no
 * session to write and no worktree snapshot whose blobs the shared store must check as it records it. Every other
 * mutation commits to the shared journal before the step returns, as without shipping.
 */
export function shippableCheckpoint(
	mutation: PoolMutation,
): mutation is Extract<PoolCheckpointMutation, { kind: "checkpoint" }> {
	if (mutation.kind !== "checkpoint") return false;
	const checkpoint = mutation.checkpoint;
	if (checkpoint.kind === "stage" && checkpoint.sessionId !== undefined) return false;
	const snapshots = (checkpoint as { readonly worktreeSnapshots?: unknown }).worktreeSnapshots;
	return !(Array.isArray(snapshots) && snapshots.length > 0);
}

/** A local journal failure that sent an attempt back to committing every checkpoint to the shared journal. */
export interface ShippingFallback {
	readonly workId: string;
	readonly error: Error;
}

/**
 * How a host commits its attempts' checkpoints when their root ships checkpoints (#4768). A shippable checkpoint is
 * accepted into the host's local journal under the attempt's lease, then shipped. An attempt whose local journal
 * fails (a full disk, a corrupt file) commits to the shared journal from then on, and the failure is reported once.
 *
 * Until the background shipper exists, every accepted checkpoint is shipped before the commit returns: the shared
 * commit is its delivery, with the same operation, so the receipt is the shared journal's and nothing else changes.
 */
export class CheckpointShipping {
	private readonly syncOnly = new Set<string>();

	constructor(
		private readonly shard: ShipShard,
		private readonly onFallback: (fallback: ShippingFallback) => void = () => {},
	) {}

	/** The attempt holds its work's lease as of now: at its claim and at each renewal. */
	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		try {
			await this.shard.hold(lease, leaseMs);
		} catch (error) {
			this.fallBack(lease.id, error as Error);
		}
	}

	/** The attempt ended or lost its work: the host accepts nothing more for it. */
	release(workId: string): void {
		this.shard.release(workId);
		this.syncOnly.delete(workId);
	}

	/** Whether the attempt commits every checkpoint to the shared journal, after its local journal failed. */
	isSyncOnly(workId: string): boolean {
		return this.syncOnly.has(workId);
	}

	/**
	 * Commits `mutation` for the attempt `lease`. `commitShared` commits it to the shared journal, under the shared
	 * store's own fences; it is also how an accepted checkpoint is delivered.
	 */
	async commit(
		lease: AttemptLease,
		mutation: PoolMutation,
		commitShared: () => Promise<PoolCommitReceipt>,
	): Promise<PoolCommitReceipt> {
		if (!shippableCheckpoint(mutation) || this.syncOnly.has(lease.id)) return commitShared();
		const checkpoint = mutation.checkpoint;
		let localSeq: number;
		try {
			({ localSeq } = await this.shard.accept(
				this.shard.root,
				lease,
				checkpointKey(checkpoint),
				serializeJson(payloadOf(checkpoint)),
				checkpoint.completedAt,
			));
		} catch (error) {
			if (error instanceof StaleWorkLeaseError || isIdentityConflict(error)) throw error;
			this.fallBack(lease.id, error as Error);
			return commitShared();
		}
		let receipt: PoolCommitReceipt;
		try {
			receipt = await commitShared();
		} catch (error) {
			if (error instanceof StaleWorkLeaseError) await this.shard.fence(lease).catch(() => {});
			throw error;
		}
		try {
			await this.shard.shipped(lease, localSeq);
		} catch (error) {
			// The shared journal holds the checkpoint; the local journal only failed to forget it.
			this.fallBack(lease.id, error as Error);
		}
		return receipt;
	}

	close(): Promise<void> {
		this.syncOnly.clear();
		return this.shard.close();
	}

	private fallBack(workId: string, error: Error): void {
		if (this.syncOnly.has(workId)) return;
		this.syncOnly.add(workId);
		this.onFallback({ workId, error });
	}
}

function isIdentityConflict(error: unknown): boolean {
	return error instanceof Error && error.message === "Pool checkpoint identity conflict";
}

/** The checkpoint as the JSON value the shared journal records, checked serializable as the shared commit checks it. */
function payloadOf(checkpoint: unknown) {
	assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
	return checkpoint;
}
