import type { PoolCheckpointMutation, PoolMutation } from "../durable/journal/pool-mutations.js";
import { checkpointKey, type PoolCommitReceipt } from "../durable/journal/sql-pool-queue.js";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { serializeJson } from "../durable/journal/values.js";
import { assertWorkflowSerializableObject } from "../shared/serializable.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import { ShipIdentityConflictError, type ShipShard } from "./ship-shard.js";

export function shippableCheckpoint(
	mutation: PoolMutation,
): mutation is Extract<PoolCheckpointMutation, { kind: "checkpoint" }> {
	if (mutation.kind !== "checkpoint") return false;
	const checkpoint = mutation.checkpoint;
	if (checkpoint.kind === "stage" && checkpoint.sessionId !== undefined) return false;
	const snapshots = (checkpoint as { readonly worktreeSnapshots?: unknown }).worktreeSnapshots;
	return !(Array.isArray(snapshots) && snapshots.length > 0);
}

export interface ShippingFallback {
	readonly workId: string;
	readonly error: Error;
}

export class CheckpointShipping {
	private readonly syncOnly = new Map<string, number>();
	private readonly generations = new Map<string, number>();

	constructor(
		private readonly shard: ShipShard,
		private readonly onFallback: (fallback: ShippingFallback) => void = () => {},
	) {}

	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		const current = this.generations.get(lease.id);
		if (current !== undefined && lease.generation > current) {
			this.syncOnly.delete(lease.id);
		}
		if (current === undefined || lease.generation > current) {
			this.generations.set(lease.id, lease.generation);
		}
		try {
			await this.shard.hold(lease, leaseMs);
		} catch (error) {
			this.fallBack(lease, error as Error);
		}
	}

	release(work: string | Pick<AttemptLease, "id" | "generation">): void {
		this.shard.release(work);
		if (typeof work === "string") {
			this.generations.delete(work);
			this.syncOnly.delete(work);
			return;
		}
		const current = this.generations.get(work.id);
		if (current !== undefined && work.generation < current) return;
		this.generations.delete(work.id);
		if ((this.syncOnly.get(work.id) ?? 0) <= work.generation) {
			this.syncOnly.delete(work.id);
		}
	}

	isSyncOnly(work: string | Pick<AttemptLease, "id" | "generation">): boolean {
		if (typeof work === "string") {
			const generation = this.generations.get(work);
			return generation !== undefined && this.syncOnly.get(work) === generation;
		}
		return this.syncOnly.get(work.id) === work.generation;
	}

	async commit(
		lease: AttemptLease,
		mutation: PoolMutation,
		commitShared: () => Promise<PoolCommitReceipt>,
		renewAttempt?: () => Promise<void>,
	): Promise<PoolCommitReceipt> {
		if (!shippableCheckpoint(mutation) || this.isSyncOnly(lease)) return this.deliver(lease, commitShared);
		const checkpoint = mutation.checkpoint;
		const key = checkpointKey(checkpoint);
		const payload = serializeJson(payloadOf(checkpoint));
		const localSeq = await this.acceptWithRenewal(lease, key, payload, checkpoint.completedAt, renewAttempt);
		if (localSeq === undefined) return this.deliver(lease, commitShared);
		const receipt = await this.deliver(lease, commitShared, localSeq);
		try {
			await this.shard.shipped(lease, localSeq);
		} catch (error) {
			this.fallBack(lease, error as Error);
		}
		return receipt;
	}

	close(): Promise<void> {
		this.syncOnly.clear();
		this.generations.clear();
		return this.shard.close();
	}

	private async acceptWithRenewal(
		lease: AttemptLease,
		key: string,
		payload: string,
		at: number,
		renewAttempt?: () => Promise<void>,
	): Promise<number | undefined> {
		try {
			const { localSeq } = await this.shard.accept(this.shard.root, lease, key, payload, at);
			return localSeq;
		} catch (error) {
			if (error instanceof StaleWorkLeaseError && error.reason === "expired" && renewAttempt !== undefined) {
				try {
					await renewAttempt();
				} catch (renewError) {
					if (renewError instanceof StaleWorkLeaseError) await this.fenceAttempt(lease);
					throw renewError;
				}
				if (this.isSyncOnly(lease)) return undefined;
				try {
					const { localSeq } = await this.shard.accept(this.shard.root, lease, key, payload, at);
					return localSeq;
				} catch (retryError) {
					if (retryError instanceof StaleWorkLeaseError || retryError instanceof ShipIdentityConflictError)
						throw retryError;
					this.fallBack(lease, retryError as Error);
					return undefined;
				}
			}
			if (error instanceof StaleWorkLeaseError || error instanceof ShipIdentityConflictError) throw error;
			this.fallBack(lease, error as Error);
			return undefined;
		}
	}

	private async deliver(
		lease: AttemptLease,
		commitShared: () => Promise<PoolCommitReceipt>,
		localSeq?: number,
	): Promise<PoolCommitReceipt> {
		try {
			return await commitShared();
		} catch (error) {
			if (error instanceof StaleWorkLeaseError) {
				await this.fenceAttempt(lease);
			} else if (localSeq !== undefined) {
				try {
					await this.shard.discard(lease, localSeq);
				} catch (discardError) {
					this.fallBack(lease, discardError as Error);
				}
			}
			throw error;
		}
	}

	private async fenceAttempt(lease: AttemptLease): Promise<void> {
		try {
			await this.shard.fence(lease);
		} catch (fenceError) {
			this.fallBack(lease, fenceError as Error);
			return;
		}
		if (this.syncOnly.get(lease.id) === lease.generation) {
			this.syncOnly.delete(lease.id);
		}
		if (this.generations.get(lease.id) === lease.generation) {
			this.generations.delete(lease.id);
		}
	}

	private fallBack(lease: Pick<AttemptLease, "id" | "generation">, error: Error): void {
		const current = this.generations.get(lease.id);
		if (current !== undefined && lease.generation < current) return;
		if (current === undefined || lease.generation > current) {
			this.generations.set(lease.id, lease.generation);
		}
		if (this.syncOnly.get(lease.id) === lease.generation) return;
		this.syncOnly.set(lease.id, lease.generation);
		this.onFallback({ workId: lease.id, error });
	}
}

function payloadOf(checkpoint: unknown) {
	assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
	return checkpoint;
}
