import type { PoolCheckpointMutation, PoolMutation } from "../durable/journal/pool-mutations.js";
import { poolCheckpointUsage } from "../durable/journal/pool-stage-usage.js";
import { checkpointKey, type PoolCommitReceipt, type PoolShipBatch } from "../durable/journal/sql-pool-queue.js";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleLeaseError } from "../durable/journal/types.js";
import { serializeJson } from "../durable/journal/values.js";
import { assertWorkflowSerializableObject } from "../shared/serializable.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import type { ResolvedCheckpointShipping } from "./public-options.js";
import type { ShipShard } from "./ship-shard.js";

/**
 * Whether a host may keep `mutation` in its local journal and ship it later (#4768): a plain checkpoint, with no
 * session to write, no worktree snapshot whose blobs the shared store must check as it records it, and no model usage
 * to bill, so the root's budget always sees usage as soon as it is spent. Every other mutation commits to the shared
 * journal before the step returns, as without shipping.
 */
export function shippableCheckpoint(
	mutation: PoolMutation,
): mutation is Extract<PoolCheckpointMutation, { kind: "checkpoint" }> {
	if (mutation.kind !== "checkpoint") return false;
	const checkpoint = mutation.checkpoint;
	if (checkpoint.kind === "stage" && checkpoint.sessionId !== undefined) return false;
	if (poolCheckpointUsage(checkpoint) !== undefined) return false;
	const snapshots = (checkpoint as { readonly worktreeSnapshots?: unknown }).worktreeSnapshots;
	return !(Array.isArray(snapshots) && snapshots.length > 0);
}

/** A local journal failure that sent an attempt back to committing every checkpoint to the shared journal. */
export interface ShippingFallback {
	readonly workId: string;
	readonly error: Error;
}

/** Delivers one batch of an attempt to the shared journal, under its fences: `SqlPoolQueue.shipBatch`. */
export type ShipDelivery = (attempt: AttemptLease, batch: PoolShipBatch) => Promise<void>;

/** What a host's shipping looks like now, for its status. */
export interface ShippingStatus {
	/** Checkpoints accepted and not shipped yet, across the host's attempts. */
	readonly pending: number;
	/** How long, in milliseconds, the oldest of them has waited. */
	readonly lagMs: number;
	/** The last failure to deliver a batch, until a delivery succeeds again. */
	readonly error?: Error;
}

interface Attempt {
	lease: AttemptLease;
	/** When each unshipped checkpoint was accepted, oldest first, by the monotonic clock. */
	accepted: number[];
	/** The attempt's shipping, one batch at a time. */
	chain: Promise<void>;
	/** Why the attempt can ship no more: the shared journal refused it, so its next commit is refused too. */
	fenced?: Error;
}

/**
 * How a host commits its attempts' checkpoints when their root ships checkpoints (#4768). A shippable checkpoint is
 * accepted into the host's local journal under the attempt's lease and acknowledged at once; a shipper delivers what
 * each attempt accepted to the shared journal in batches, every `intervalMs` or once `maxBatch` wait. Every other
 * mutation first ships what the attempt accepted before it, so the shared journal always holds an attempt's
 * checkpoints in the order the attempt took its steps. An attempt's work completes, and its control is acknowledged,
 * only after everything it accepted is shipped.
 *
 * An attempt whose local journal fails (a full disk, a corrupt file) commits to the shared journal from then on, and
 * the failure is reported once. An attempt the shared journal refuses because another attempt owns its work is fenced:
 * what it accepted and did not ship is dropped, and its next commit is refused, as the shared journal would refuse it.
 */
export class CheckpointShipping {
	private readonly syncOnly = new Set<string>();
	private readonly attempts = new Map<string, Attempt>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastError: Error | undefined;
	private closed = false;

	constructor(
		private readonly shard: ShipShard,
		private readonly options: ResolvedCheckpointShipping & {
			readonly host: string;
			readonly deliver: ShipDelivery;
			readonly onFallback?: (fallback: ShippingFallback) => void;
			/** The monotonic clock, in milliseconds. */
			readonly now?: () => number;
		},
	) {}

	/** Ships every `intervalMs` until {@link close}. */
	start(): void {
		if (this.timer !== undefined || this.closed) return;
		this.timer = setInterval(() => void this.shipAll().catch(() => {}), this.options.intervalMs);
		this.timer.unref?.();
	}

	/** The attempt holds its work's lease as of now: at its claim and at each renewal. */
	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		const known = this.attempts.get(lease.id);
		if (known === undefined || known.lease.generation !== lease.generation)
			this.attempts.set(lease.id, { lease: { ...lease }, accepted: [], chain: Promise.resolve() });
		else known.lease = { ...lease };
		try {
			await this.shard.hold(lease, leaseMs);
		} catch (error) {
			this.fallBack(lease.id, error as Error);
		}
	}

	/**
	 * The attempt ended or lost its work: what it accepted is shipped first, while its lease may still hold, and then the
	 * host accepts nothing more for it.
	 */
	async release(workId: string): Promise<void> {
		const attempt = this.attempts.get(workId);
		if (attempt !== undefined) await this.flush(attempt.lease).catch(() => {});
		this.attempts.delete(workId);
		this.shard.release(workId);
		this.syncOnly.delete(workId);
	}

	/** Whether the attempt commits every checkpoint to the shared journal, after its local journal failed. */
	isSyncOnly(workId: string): boolean {
		return this.syncOnly.has(workId);
	}

	/**
	 * Commits `mutation` for the attempt `lease`. `commitShared` commits it to the shared journal, under the shared
	 * store's own fences.
	 */
	async commit(
		lease: AttemptLease,
		mutation: PoolMutation,
		commitShared: () => Promise<PoolCommitReceipt>,
	): Promise<PoolCommitReceipt> {
		const fenced = this.attempts.get(lease.id)?.fenced;
		if (fenced !== undefined && this.attempts.get(lease.id)?.lease.generation === lease.generation) throw fenced;
		if (!shippableCheckpoint(mutation) || this.syncOnly.has(lease.id)) {
			await this.flush(lease);
			return commitShared();
		}
		const checkpoint = mutation.checkpoint;
		try {
			const { accepted } = await this.shard.accept(
				this.shard.root,
				lease,
				checkpointKey(checkpoint),
				serializeJson(payloadOf(checkpoint)),
				checkpoint.completedAt,
			);
			if (accepted) this.noteAccepted(lease);
		} catch (error) {
			if (error instanceof StaleWorkLeaseError || isIdentityConflict(error)) throw error;
			this.fallBack(lease.id, error as Error);
			await this.flush(lease);
			return commitShared();
		}
		const attempt = this.attempts.get(lease.id);
		if (attempt !== undefined && attempt.accepted.length >= this.options.maxBatch)
			void this.ship(attempt).catch(() => {});
		return { at: Date.now(), local: true };
	}

	/**
	 * Ships everything the attempt accepted. Rejects with the shared journal's refusal once another attempt owns its
	 * work, and with a delivery's failure when the shared journal cannot be reached.
	 */
	async flush(lease: Pick<AttemptLease, "id" | "generation">): Promise<void> {
		const attempt = this.attempts.get(lease.id);
		if (attempt === undefined || attempt.lease.generation !== lease.generation) return;
		for (;;) {
			if (attempt.fenced !== undefined) throw attempt.fenced;
			if ((await this.shard.pendingCount(attempt.lease)) === 0) {
				attempt.accepted = [];
				return;
			}
			await this.ship(attempt);
		}
	}

	/** Ships everything every attempt accepted: before a control revision is acknowledged, and before the host stops. */
	async flushAll(): Promise<void> {
		const failures: unknown[] = [];
		for (const attempt of [...this.attempts.values()])
			await this.flush(attempt.lease).catch((error) => failures.push(error));
		if (failures.length > 0) throw failures[0];
	}

	/** How far behind the host's shipping is, for its claim gate and its status. */
	status(): ShippingStatus {
		const now = this.now();
		let pending = 0;
		let lagMs = 0;
		for (const attempt of this.attempts.values()) {
			pending += attempt.accepted.length;
			const oldest = attempt.accepted[0];
			if (oldest !== undefined) lagMs = Math.max(lagMs, now - oldest);
		}
		return { pending, lagMs, ...(this.lastError === undefined ? {} : { error: this.lastError }) };
	}

	/** Whether the host is so far behind that it claims no new children until it catches up (`maxLagMs`). */
	lagging(): boolean {
		return this.status().lagMs > this.options.maxLagMs;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		await Promise.all([...this.attempts.values()].map((attempt) => attempt.chain.catch(() => {})));
		this.attempts.clear();
		this.syncOnly.clear();
		await this.shard.close();
	}

	private async shipAll(): Promise<void> {
		for (const attempt of [...this.attempts.values()])
			if (attempt.accepted.length > 0 && attempt.fenced === undefined) await this.ship(attempt).catch(() => {});
	}

	/** Ships the attempt's next batch, after any shipment of the attempt still running. */
	private ship(attempt: Attempt): Promise<void> {
		const next = attempt.chain.catch(() => {}).then(() => this.shipOne(attempt));
		attempt.chain = next;
		return next;
	}

	private async shipOne(attempt: Attempt): Promise<void> {
		if (this.closed || attempt.fenced !== undefined) return;
		const lease = attempt.lease;
		const sealed = await this.shard.seal(lease, this.options.maxBatch);
		if (sealed === undefined) return;
		const batch: PoolShipBatch = {
			id: sealed.id,
			host: this.options.host,
			events: sealed.events.map((event) => ({ localSeq: event.localSeq, key: event.key, payload: event.payload })),
		};
		try {
			await this.options.deliver(lease, batch);
		} catch (error) {
			if (error instanceof StaleWorkLeaseError || error instanceof StaleLeaseError) {
				attempt.fenced =
					error instanceof StaleWorkLeaseError
						? error
						: new StaleWorkLeaseError(
								{ root: this.shard.root, workId: lease.id, generation: lease.generation, reason: "fenced" },
								{ cause: error },
							);
				attempt.accepted = [];
				await this.shard.fence(lease);
			} else this.lastError = error as Error;
			throw attempt.fenced ?? error;
		}
		this.lastError = undefined;
		await this.shard.shipped(lease, sealed.events.at(-1)!.localSeq);
		attempt.accepted.splice(0, sealed.events.length);
	}

	private noteAccepted(lease: AttemptLease): void {
		const attempt = this.attempts.get(lease.id);
		if (attempt === undefined) return;
		attempt.accepted.push(this.now());
	}

	private now(): number {
		return (this.options.now ?? (() => performance.now()))();
	}

	private fallBack(workId: string, error: Error): void {
		if (this.syncOnly.has(workId)) return;
		this.syncOnly.add(workId);
		this.options.onFallback?.({ workId, error });
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
