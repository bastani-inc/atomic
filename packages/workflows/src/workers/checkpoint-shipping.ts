import type { PoolCheckpointMutation, PoolMutation } from "../durable/journal/pool-mutations.js";
import { poolCheckpointUsage } from "../durable/journal/pool-stage-usage.js";
import { checkpointKey, type PoolCommitReceipt, type PoolShipBatch } from "../durable/journal/sql-pool-queue.js";
import type { AttemptLease } from "../durable/journal/sql-shared-pool.js";
import { StaleLeaseError } from "../durable/journal/types.js";
import { serializeJson } from "../durable/journal/values.js";
import { assertWorkflowSerializableObject } from "../shared/serializable.js";
import { StaleWorkLeaseError } from "../shared/worker-pool-errors.js";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";
import { CHECKPOINT_SHIPPING_LIMITS, type ResolvedCheckpointShipping } from "./public-options.js";
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
 * The share of `maxLagMs` past which an attempt acknowledges no new step until what it holds is shipped, until the
 * host has timed a delivery: the rest of the window is left for the delivery itself. Once it has, the point moves to
 * what the deliveries leave of the window (see {@link CheckpointShipping.backpressurePointMs}).
 */
export const BACKPRESSURE_SHARE = 0.5;
/**
 * The most checkpoints a batch carries when an attempt is near its lag bound: everything it holds goes in one round
 * trip, rather than one `maxBatch` after another. The largest `maxBatch` there is.
 */
export const URGENT_BATCH_CAP = CHECKPOINT_SHIPPING_LIMITS.maxBatch.max;
/**
 * Time kept in hand besides the deliveries, for the deadline check's own period and timers that fire late: an attempt
 * starts shipping this long before its deliveries would end exactly at `maxLagMs`.
 */
export const SCHEDULING_MARGIN_MS = 100;
/** How often a started host checks whether an attempt has reached its backpressure point. */
const DEADLINE_CHECK_MS = 25;
/** The weight of the latest delivery in the running average of delivery times. */
const DELIVERY_EWMA_WEIGHT = 0.3;
/** How many recent delivery times the 95th percentile is taken over. */
const DELIVERY_SAMPLES = 20;
/** A host ships at least this often within `maxLagMs`, whatever its `intervalMs`. */
export const SHIPS_PER_LAG_WINDOW = 4;
/** How many of its attempts' batches a host delivers at once on its interval. */
export const SHIP_CONCURRENCY = 2;
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
	/**
	 * Each unshipped checkpoint, oldest first: its local sequence and when it was accepted, by the monotonic clock. An
	 * entry goes only once the shared journal holds its checkpoint, or the attempt is fenced, so a read of the local
	 * journal that raced an accept never drops one (#4768).
	 */
	accepted: { readonly localSeq: number; readonly at: number }[];
	/** The attempt's shipping, one batch at a time. */
	chain: Promise<void>;
	/** Why the attempt can ship no more: the shared journal refused it, so its next commit is refused too. */
	fenced?: Error;
	/** How many shipments of the attempt are queued or running. */
	shipping?: number;
	/** A shipment the deadline check started for it, still running. */
	urgent?: Promise<void>;
	/** After a deadline shipment failed: when the next may start, by the monotonic clock, and how many failed in a row. */
	retryAt?: number;
	failures?: number;
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
	private deadlines: ReturnType<typeof setInterval> | undefined;
	/** How long recent deliveries took: a running average, and the latest times for their 95th percentile. */
	private deliveryEwmaMs: number | undefined;
	private readonly deliverySamples: number[] = [];
	private deliveryP95Ms = 0;
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
	 * {@link close}.
	 */
	start(): void {
		if (this.timer !== undefined || this.closed) return;
		const every = Math.min(this.options.intervalMs, Math.floor(this.options.maxLagMs / SHIPS_PER_LAG_WINDOW));
		this.timer = setInterval(() => void this.shipAll().catch(() => {}), every);
		this.timer.unref?.();
		this.deadlines = setInterval(() => this.shipDue(), DEADLINE_CHECK_MS);
		this.deadlines.unref?.();
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
			const { localSeq, accepted } = await this.shard.accept(
				this.shard.root,
				lease,
				checkpointKey(checkpoint),
				serializeJson(payloadOf(checkpoint)),
				checkpoint.completedAt,
			);
			if (accepted) this.noteAccepted(lease, localSeq);
		} catch (error) {
			if (error instanceof StaleWorkLeaseError || error instanceof ShipIdentityConflictError) throw error;
			this.fallBack(lease.id, error as Error);
			await this.flush(lease);
			return commitShared();
		}
		const attempt = this.attempts.get(lease.id);
		// A full batch ships at once, unless a shipment is queued already: it takes what has come since when it runs.
		if (attempt !== undefined && attempt.accepted.length >= this.options.maxBatch && !attempt.shipping)
			void this.ship(attempt).catch(() => {});
		return { at: Date.now(), local: true };
	}

	/**
	 * Ships everything the attempt accepted. Rejects with the shared journal's refusal once another attempt owns its
	 * work, and with a delivery's failure when the shared journal cannot be reached.
	 */
	async flush(lease: Pick<AttemptLease, "id" | "generation">, cap = this.options.maxBatch): Promise<void> {
		const attempt = this.attempts.get(lease.id);
		if (attempt === undefined || attempt.lease.generation !== lease.generation) return;
		for (;;) {
			if (attempt.fenced !== undefined) throw attempt.fenced;
			if ((await this.shard.pendingCount(attempt.lease)) === 0) return;
			await this.ship(attempt, cap);
		}
	}

	/**
	 * Backpressure: an attempt whose oldest unshipped checkpoint reached its backpressure point
	 * ({@link backpressurePointMs}) acknowledges no new step until everything it holds is shipped, in one round trip,
	 * retrying a delivery the store did not take, so the steps a host's death leaves to run again stay within that window. Rejects once the attempt is fenced, the host
	 * stops, or the shared journal refuses the delivery: retrying a refusal would hold the step back for good.
	 */
	private async catchUp(lease: AttemptLease): Promise<void> {
		for (let tries = 0; ; tries++) {
			const attempt = this.attempts.get(lease.id);
			const oldest = attempt?.accepted[0]?.at;
			if (attempt === undefined || oldest === undefined || this.now() - oldest < this.backpressurePointMs(attempt))
				return;
			if (attempt.fenced !== undefined) throw attempt.fenced;
			if (this.closed) throw new Error("Checkpoint shipping stopped");
			try {
				await this.flush(lease, URGENT_BATCH_CAP);
				return;
			} catch (error) {
				if (attempt.fenced !== undefined) throw attempt.fenced;
				if (infrastructureFaultOf(error) !== "storage_unavailable") throw error;
				await sleep(Math.min(BACKPRESSURE_RETRY_MAX_MS, BACKPRESSURE_RETRY_MS * 2 ** Math.min(tries, 10)));
			}
		}
	}

	/**
	 * How old an attempt's oldest unshipped checkpoint may grow before it is shipped at once and the attempt's next step
	 * waits for it (#4768). What is left of `maxLagMs` once the deliveries that may still be needed are counted: one
	 * already under way, and everything the attempt holds in one round trip ({@link URGENT_BATCH_CAP} at a time), each
	 * taking the larger of the recent average and 95th percentile delivery time, with {@link SCHEDULING_MARGIN_MS} in
	 * hand. Before the host timed a delivery: {@link BACKPRESSURE_SHARE} of `maxLagMs`. A store whose deliveries take
	 * half of `maxLagMs` or more leaves nothing: every step then waits for the one before it to be shipped.
	 */
	backpressurePointMs(attempt?: { readonly accepted: readonly unknown[] }): number {
		const estimate = this.deliveryEstimateMs();
		if (estimate === undefined) return this.options.maxLagMs * BACKPRESSURE_SHARE;
		const deliveries = 1 + Math.max(1, Math.ceil((attempt?.accepted.length ?? 0) / URGENT_BATCH_CAP));
		return Math.max(0, this.options.maxLagMs - deliveries * estimate - SCHEDULING_MARGIN_MS);
	}

	/** The larger of the recent average and 95th percentile delivery time; undefined before any delivery. */
	private deliveryEstimateMs(): number | undefined {
		if (this.deliveryEwmaMs === undefined) return undefined;
		return Math.max(this.deliveryEwmaMs, this.deliveryP95Ms);
	}

	private noteDelivery(ms: number): void {
		this.deliveryEwmaMs =
			this.deliveryEwmaMs === undefined
				? ms
				: this.deliveryEwmaMs + DELIVERY_EWMA_WEIGHT * (ms - this.deliveryEwmaMs);
		this.deliverySamples.push(ms);
		if (this.deliverySamples.length > DELIVERY_SAMPLES) this.deliverySamples.shift();
		const sorted = [...this.deliverySamples].sort((left, right) => left - right);
		this.deliveryP95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
	}

	/**
	 * Starts shipping, in one round trip, everything each attempt holds whose oldest checkpoint reached the attempt's
	 * backpressure point: without waiting for the interval, for a step of the attempt, or for other attempts'
	 * deliveries. A shipment that fails is tried again after a growing wait.
	 */
	private shipDue(): void {
		if (this.closed) return;
		const now = this.now();
		for (const attempt of this.attempts.values()) {
			const oldest = attempt.accepted[0]?.at;
			if (oldest === undefined || attempt.fenced !== undefined || attempt.urgent !== undefined) continue;
			if (attempt.retryAt !== undefined && now < attempt.retryAt) continue;
			if (now - oldest < this.backpressurePointMs(attempt)) continue;
			attempt.urgent = this.flush(attempt.lease, URGENT_BATCH_CAP)
				.then(() => {
					attempt.failures = 0;
					attempt.retryAt = undefined;
				})
				.catch(() => {
					attempt.failures = (attempt.failures ?? 0) + 1;
					attempt.retryAt =
						this.now() +
						Math.min(BACKPRESSURE_RETRY_MAX_MS, BACKPRESSURE_RETRY_MS * 2 ** Math.min(attempt.failures - 1, 10));
				})
				.finally(() => {
					attempt.urgent = undefined;
				});
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
			const oldest = attempt.accepted[0]?.at;
			if (oldest !== undefined) lagMs = Math.max(lagMs, now - oldest);
		}
		return { pending, lagMs, ...(this.lastError === undefined ? {} : { error: this.lastError }) };
	}

	/**
	 * Whether the host is so far behind that it claims no new children until it catches up: an attempt holds a
	 * checkpoint as old as its backpressure point ({@link backpressurePointMs}).
	 */
	lagging(): boolean {
		const now = this.now();
		for (const attempt of this.attempts.values()) {
			const oldest = attempt.accepted[0]?.at;
			if (oldest !== undefined && now - oldest >= this.backpressurePointMs(attempt)) return true;
		}
		return false;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		clearInterval(this.deadlines);
		await Promise.all(
			[...this.attempts.values()].flatMap((attempt) => [attempt.chain.catch(() => {}), attempt.urgent]),
		);
		this.attempts.clear();
		this.syncOnly.clear();
		await this.shard.close();
	}

	/**
	 * Ships each attempt's next batch, the attempt holding the oldest checkpoint first, at most
	 * {@link SHIP_CONCURRENCY} deliveries at a time, so a host's shipping adds few requests to the store's concurrent
	 * ones however many attempts it runs.
	 */
	private async shipAll(): Promise<void> {
		// Oldest checkpoint first: with deliveries slower than the interval, the attempt nearest its lag bound goes first.
		const waiting = [...this.attempts.values()]
			.filter((attempt) => attempt.accepted.length > 0 && attempt.fenced === undefined)
			.sort((left, right) => left.accepted[0]!.at - right.accepted[0]!.at);
		const lane = async () => {
			for (let attempt = waiting.shift(); attempt !== undefined; attempt = waiting.shift())
				await this.ship(attempt).catch(() => {});
		};
		await Promise.all(Array.from({ length: SHIP_CONCURRENCY }, lane));
	}

	/** Ships the attempt's next batch of at most `cap` checkpoints, after any shipment of the attempt still running. */
	private ship(attempt: Attempt, cap = this.options.maxBatch): Promise<void> {
		attempt.shipping = (attempt.shipping ?? 0) + 1;
		const next = attempt.chain
			.catch(() => {})
			.then(() => this.shipOne(attempt, cap))
			.finally(() => {
				attempt.shipping = (attempt.shipping ?? 1) - 1;
			});
		attempt.chain = next;
		return next;
	}

	private async shipOne(attempt: Attempt, cap: number): Promise<void> {
		if (this.closed || attempt.fenced !== undefined) return;
		const lease = attempt.lease;
		// An attempt at its backpressure point ships everything it holds in one round trip, whoever asked.
		const oldest = attempt.accepted[0]?.at;
		const urgent = oldest !== undefined && this.now() - oldest >= this.backpressurePointMs(attempt);
		const sealed = await this.shard.seal(lease, urgent ? Math.max(cap, URGENT_BATCH_CAP) : cap);
		if (sealed === undefined) return;
		const batch: PoolShipBatch = {
			id: sealed.id,
			host: this.options.host,
			events: sealed.events.map((event) => ({ localSeq: event.localSeq, key: event.key, payload: event.payload })),
		};
		const began = this.now();
		try {
			await this.options.deliver(lease, batch);
			this.noteDelivery(this.now() - began);
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
		const last = sealed.events.at(-1)!.localSeq;
		attempt.accepted = attempt.accepted.filter((entry) => entry.localSeq > last);
	}

	private noteAccepted(lease: AttemptLease, localSeq: number): void {
		const attempt = this.attempts.get(lease.id);
		if (attempt === undefined) return;
		attempt.accepted.push({ localSeq, at: this.now() });
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
