import type { PoolCheckpointMutation, PoolMutation } from "../durable/journal/pool-mutations.js";
import { poolCheckpointUsage } from "../durable/journal/pool-stage-usage.js";
import { checkpointKey, type PoolCommitReceipt, type PoolShipBatch } from "../durable/journal/sql-pool-queue.js";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleLeaseError } from "../durable/journal/types.js";
import { serializeJson } from "../durable/journal/values.js";
import { assertWorkflowSerializableObject } from "../shared/serializable.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import type { ResolvedCheckpointShipping } from "./public-options.js";
import { ShipIdentityConflictError, type ShipShard } from "./ship-shard.js";

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

/** How many times an attempt's checkpoints are shipped before its work is released without them. */
export const RELEASE_FLUSH_ATTEMPTS = 4;
/** The first wait between those tries; each next one is twice as long. */
export const RELEASE_FLUSH_RETRY_MS = 250;

/**
 * The share of `maxLagMs` past which an attempt acknowledges no new step until what it holds is shipped: the rest of
 * the window is left for the delivery itself, so a checkpoint is shipped within `maxLagMs` of its step.
 */
export const BACKPRESSURE_SHARE = 0.5;
/** A host ships at least this often within `maxLagMs`, whatever its `intervalMs`. */
export const SHIPS_PER_LAG_WINDOW = 4;
/** The first wait before a delivery that held an attempt back is tried again; each next one is twice as long. */
const BACKPRESSURE_RETRY_MS = 100;
/** The longest wait between those tries. */
const BACKPRESSURE_RETRY_MAX_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
			/**
			 * An attempt's work is released with checkpoints it accepted still unshipped, after {@link RELEASE_FLUSH_ATTEMPTS}
			 * tries: they ship later only if no other attempt took the work over.
			 */
			readonly onReleaseFailure?: (failure: ShippingFallback) => void;
			/** The monotonic clock, in milliseconds. */
			readonly now?: () => number;
		},
	) {}

	/**
	 * Ships every `intervalMs`, or every {@link SHIPS_PER_LAG_WINDOW}th of `maxLagMs` when that is sooner, until
	 * {@link close}. What a stopped host of this journal left unshipped ships first, under the work lease it was
	 * accepted under: the shared journal records it while that attempt still owns its work, and refuses it, so it is
	 * dropped, once another does.
	 */
	start(): void {
		if (this.timer !== undefined || this.closed) return;
		void this.recover().catch(() => {});
		const every = Math.min(this.options.intervalMs, Math.floor(this.options.maxLagMs / SHIPS_PER_LAG_WINDOW));
		this.timer = setInterval(() => void this.shipAll().catch(() => {}), every);
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
		if (attempt !== undefined)
			for (let tries = 1; ; tries++) {
				try {
					await this.flush(attempt.lease);
					break;
				} catch (error) {
					// A fenced attempt's checkpoints are dropped: another attempt owns its work.
					if (attempt.fenced !== undefined) break;
					if (tries >= RELEASE_FLUSH_ATTEMPTS) {
						this.options.onReleaseFailure?.({ workId, error: error as Error });
						break;
					}
					await sleep(RELEASE_FLUSH_RETRY_MS * 2 ** (tries - 1));
				}
			}
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
		await this.catchUp(lease);
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
			if (error instanceof StaleWorkLeaseError || error instanceof ShipIdentityConflictError) throw error;
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

	/**
	 * Backpressure: an attempt whose oldest unshipped checkpoint waited {@link BACKPRESSURE_SHARE} of `maxLagMs`
	 * acknowledges no new step until everything it holds is shipped, retrying a delivery that fails, so the steps a
	 * host's death leaves to run again stay within that window. Rejects once the attempt is fenced or the host stops.
	 */
	private async catchUp(lease: AttemptLease): Promise<void> {
		for (let tries = 0; ; tries++) {
			const attempt = this.attempts.get(lease.id);
			const oldest = attempt?.accepted[0];
			if (attempt === undefined || oldest === undefined || this.now() - oldest < this.backpressureMs()) return;
			if (attempt.fenced !== undefined) throw attempt.fenced;
			if (this.closed) throw new Error("Checkpoint shipping stopped");
			try {
				await this.flush(lease);
				return;
			} catch {
				if (attempt.fenced !== undefined) throw attempt.fenced;
				await sleep(Math.min(BACKPRESSURE_RETRY_MAX_MS, BACKPRESSURE_RETRY_MS * 2 ** Math.min(tries, 10)));
			}
		}
	}

	private backpressureMs(): number {
		return this.options.maxLagMs * BACKPRESSURE_SHARE;
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

	/**
	 * Whether the host is so far behind that it claims no new children until it catches up: an attempt holds a
	 * checkpoint as old as the backpressure point ({@link BACKPRESSURE_SHARE} of `maxLagMs`).
	 */
	lagging(): boolean {
		return this.status().lagMs >= this.backpressureMs();
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

	/** Takes up the attempts a stopped host left checkpoints of, so they ship (see {@link start}). */
	async recover(): Promise<void> {
		for (const { lease, pending } of await this.shard.leftover()) {
			if (this.attempts.has(lease.id)) continue;
			const now = this.now();
			this.attempts.set(lease.id, { lease, accepted: Array(pending).fill(now), chain: Promise.resolve() });
			await this.flush(lease).catch(() => {});
		}
	}

	/** Ships each attempt's next batch, the attempts' deliveries side by side. */
	private async shipAll(): Promise<void> {
		await Promise.all(
			[...this.attempts.values()]
				.filter((attempt) => attempt.accepted.length > 0 && attempt.fenced === undefined)
				.map((attempt) => this.ship(attempt).catch(() => {})),
		);
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

/** The checkpoint as the JSON value the shared journal records, checked serializable as the shared commit checks it. */
function payloadOf(checkpoint: unknown) {
	assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
	return checkpoint;
}
