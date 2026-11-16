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

class DeliveryTiming {
	private ewmaMs: number | undefined;
	private ewmaSize: number | undefined;
	private readonly samples: number[] = [];
	private p95Ms = 0;

	get count(): number {
		return this.samples.length;
	}

	estimate(): number | undefined {
		return this.ewmaMs === undefined ? undefined : Math.max(this.ewmaMs, this.p95Ms);
	}

	get averageSize(): number | undefined {
		return this.ewmaSize;
	}

	/** The running average of delivery times: the time of a delivery of {@link averageSize} checkpoints. */
	get averageMs(): number | undefined {
		return this.ewmaMs;
	}

	note(ms: number, size: number): void {
		this.ewmaMs = this.ewmaMs === undefined ? ms : this.ewmaMs + DELIVERY_EWMA_WEIGHT * (ms - this.ewmaMs);
		this.ewmaSize =
			this.ewmaSize === undefined ? size : this.ewmaSize + DELIVERY_EWMA_WEIGHT * (size - this.ewmaSize);
		this.samples.push(ms);
		if (this.samples.length > DELIVERY_SAMPLES) this.samples.shift();
		const sorted = [...this.samples].sort((left, right) => left - right);
		this.p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
	}
}

interface Attempt {
	lease: AttemptLease;
	shippedThrough: number;
	/**
	 * Each unshipped checkpoint, oldest first: its local sequence and when it was accepted, by the monotonic clock. An
	 * entry goes only once the shared journal holds its checkpoint, or the attempt is fenced, so a read of the local
	 * journal that raced an accept never drops one (#4768).
	 */
	accepted: { readonly localSeq: number; readonly at: number }[];
	/** The attempt's shipping, one batch at a time. */
	chain: Promise<void>;
	recovered?: boolean;
	/** Why the attempt can ship no more: the shared journal refused it, so its next commit is refused too. */
	fenced?: Error;
	/** How many shipments of the attempt are queued or running. */
	shipping?: number;
	/** A shipment the deadline check started for it, still running. */
	urgent?: Promise<void>;
	/** After a deadline shipment failed: when the next may start, by the monotonic clock, and how many failed in a row. */
	retryAt?: number;
	failures?: number;
	normalTiming?: DeliveryTiming;
	urgentTiming?: DeliveryTiming;
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
	private readonly syncOnly = new Map<string, number>();
	private readonly generations = new Map<string, number>();
	private readonly attempts = new Map<string, Attempt>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private deadlines: ReturnType<typeof setInterval> | undefined;
	private readonly normalTiming = new DeliveryTiming();
	private readonly urgentTiming = new DeliveryTiming();
	private lastError: Error | undefined;
	private recovery: Promise<void> | undefined;
	private recoveryScan: Promise<readonly AttemptLease[]> | undefined;
	private closed = false;

	constructor(
		private readonly shard: ShipShard,
		private readonly options: ResolvedCheckpointShipping & {
			readonly host: string;
			readonly deliver: ShipDelivery;
			readonly rootStanding?: () => Promise<"current" | "late" | "lost">;
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
		this.deadlines = setInterval(() => this.shipDue(), DEADLINE_CHECK_MS);
		this.deadlines.unref?.();
	}

	/** The attempt holds its work's lease as of now: at its claim and at each renewal. */
	async hold(lease: AttemptLease, leaseMs: number): Promise<void> {
		let recoveryFailure: Error | undefined;
		if (this.recoveryScan !== undefined)
			try {
				await this.recoveryScan;
			} catch (error) {
				recoveryFailure = error as Error;
			}
		if (this.closed) return;
		const generation = this.generations.get(lease.id);
		if (generation !== undefined && generation > lease.generation) return;
		if (generation === undefined || generation < lease.generation) {
			this.generations.set(lease.id, lease.generation);
			this.syncOnly.delete(lease.id);
		}
		const known = this.attempts.get(lease.id);
		if (known === undefined || known.lease.generation !== lease.generation)
			this.attempts.set(lease.id, {
				lease: { ...lease },
				shippedThrough: 0,
				accepted: [],
				chain: Promise.resolve(),
			});
		else {
			known.lease = { ...lease };
			known.recovered = undefined;
		}
		if (recoveryFailure !== undefined) this.fallBack(lease, recoveryFailure);
		try {
			await this.shard.hold(lease, leaseMs);
		} catch (error) {
			this.fallBack(lease, error as Error);
		}
	}

	/**
	 * The attempt ended or lost its work: what it accepted is shipped first, while its lease may still hold, and then the
	 * host accepts nothing more for it.
	 */
	async release(work: Pick<AttemptLease, "id" | "generation"> & Partial<Pick<AttemptLease, "worker">>): Promise<void> {
		const attempt = this.attempts.get(work.id);
		if (
			attempt === undefined ||
			attempt.lease.generation !== work.generation ||
			(work.worker !== undefined && attempt.lease.worker !== work.worker)
		)
			return;
		for (let tries = 1; ; tries++) {
			try {
				await this.flush(attempt.lease);
				break;
			} catch (error) {
				// A fenced attempt's checkpoints are dropped: another attempt owns its work.
				if (attempt.fenced !== undefined) break;
				if (tries >= RELEASE_FLUSH_ATTEMPTS) {
					this.options.onReleaseFailure?.({ workId: work.id, error: error as Error });
					break;
				}
				await sleep(RELEASE_FLUSH_RETRY_MS * 2 ** (tries - 1));
			}
		}
		if (this.attempts.get(work.id) !== attempt) return;
		this.attempts.delete(work.id);
		this.shard.release(work);
		if (this.syncOnly.get(work.id) === work.generation) this.syncOnly.delete(work.id);
	}

	/** Whether the attempt commits every checkpoint to the shared journal, after its local journal failed. */
	isSyncOnly(work: string | Pick<AttemptLease, "id" | "generation">): boolean {
		if (typeof work === "string") {
			const generation = this.generations.get(work);
			return generation !== undefined && this.syncOnly.get(work) === generation;
		}
		return this.syncOnly.get(work.id) === work.generation;
	}

	/**
	 * Commits `mutation` for the attempt `lease`. `commitShared` commits it to the shared journal, under the shared
	 * store's own fences.
	 */
	async commit(
		lease: AttemptLease,
		mutation: PoolMutation,
		commitShared: () => Promise<PoolCommitReceipt>,
		renewAttempt?: () => Promise<void>,
	): Promise<PoolCommitReceipt> {
		const fenced = this.attempts.get(lease.id)?.fenced;
		if (fenced !== undefined && this.attempts.get(lease.id)?.lease.generation === lease.generation) throw fenced;
		if (!shippableCheckpoint(mutation) || this.isSyncOnly(lease)) return this.commitDirect(lease, commitShared);
		const checkpoint = mutation.checkpoint;
		await this.catchUp(lease);
		const accepted = await this.acceptWithRenewal(
			lease,
			checkpointKey(checkpoint),
			serializeJson(payloadOf(checkpoint)),
			checkpoint.completedAt,
			renewAttempt,
		);
		if (accepted === undefined) return this.commitDirect(lease, commitShared);
		if (accepted.accepted) this.noteAccepted(lease, accepted.localSeq);
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
			if (this.closed) throw new Error("Checkpoint shipping stopped");
			if (attempt.fenced !== undefined) {
				await this.retireRecovered(attempt);
				throw attempt.fenced;
			}
			if (this.attempts.get(lease.id) !== attempt) return;
			if ((await this.shard.pendingCount(attempt.lease)) === 0) {
				await this.retireRecovered(attempt);
				return;
			}
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

	backpressurePointMs(attempt?: {
		readonly accepted: readonly unknown[];
		readonly normalTiming?: DeliveryTiming;
		readonly urgentTiming?: DeliveryTiming;
	}): number {
		const useAttempt = (attempt?.normalTiming?.count ?? 0) > 0;
		const normalTiming = useAttempt ? attempt!.normalTiming! : this.normalTiming;
		const urgentTiming = useAttempt ? attempt?.urgentTiming : this.urgentTiming;
		const normal = normalTiming.estimate() ?? urgentTiming?.estimate();
		if (normal === undefined) return this.options.maxLagMs * BACKPRESSURE_SHARE;
		const pending = Math.max(1, attempt?.accepted.length ?? 0);
		const catchUpSize = Math.min(pending, URGENT_BATCH_CAP);
		const initialGuess = normal * Math.ceil(catchUpSize / this.options.maxBatch);
		const urgentEstimate = urgentTiming?.estimate();
		const catchUpEstimate =
			catchUpSize <= this.options.maxBatch
				? normal
				: urgentTiming === undefined || urgentTiming.count < 2
					? Math.max(urgentEstimate ?? 0, initialGuess, this.hostTimedCatchUpMs(catchUpSize))
					: timedCatchUpMs(normal, normalTiming, urgentTiming, catchUpSize);
		const remainingMs = Math.ceil(pending / URGENT_BATCH_CAP) * catchUpEstimate;
		return Math.max(0, this.options.maxLagMs - normal - remainingMs - SCHEDULING_MARGIN_MS);
	}

	private hostTimedCatchUpMs(size: number): number {
		if (size <= this.options.maxBatch || this.urgentTiming.count < 2) return 0;
		return timedCatchUpMs(
			this.normalTiming.estimate() ?? this.urgentTiming.estimate()!,
			this.normalTiming,
			this.urgentTiming,
			size,
		);
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
			if (attempt.fenced !== undefined) continue;
			const oldest = attempt.accepted[0]?.at;
			if (oldest !== undefined && now - oldest >= this.backpressurePointMs(attempt)) return true;
		}
		return false;
	}

	async close(options: { readonly retire?: boolean } = {}): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		clearInterval(this.deadlines);
		await this.recovery?.catch(() => {});
		await Promise.all(
			[...this.attempts.values()].flatMap((attempt) => [attempt.chain.catch(() => {}), attempt.urgent]),
		);
		this.attempts.clear();
		this.syncOnly.clear();
		this.generations.clear();
		await this.shard.close(options);
	}

	/** Takes up the attempts a stopped host left checkpoints of, so they ship (see {@link start}). */
	recover(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.recovery !== undefined) return this.recovery;
		this.recoveryScan = this.recoverAttempts();
		this.recovery = this.recoveryScan
			.then(async (leases) => {
				this.recoveryScan = undefined;
				for (const lease of leases) {
					if (this.closed) return;
					await this.flush(lease).catch(() => {});
				}
			})
			.finally(() => {
				this.recovery = undefined;
				this.recoveryScan = undefined;
			});
		return this.recovery;
	}

	private async recoverAttempts(): Promise<readonly AttemptLease[]> {
		const recovered: AttemptLease[] = [];
		for (const { lease } of await this.shard.leftover()) {
			if (this.closed) return recovered;
			if (this.attempts.has(lease.id)) continue;
			const now = this.now();
			const held = await this.shard.pendingSeqs(lease);
			if (this.closed) return recovered;
			if (this.attempts.has(lease.id)) continue;
			this.generations.set(lease.id, lease.generation);
			this.attempts.set(lease.id, {
				lease,
				shippedThrough: 0,
				accepted: held.map((localSeq) => ({ localSeq, at: now })),
				chain: Promise.resolve(),
				recovered: true,
			});
			recovered.push(lease);
		}
		return recovered;
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
			.finally(async () => {
				attempt.shipping = (attempt.shipping ?? 1) - 1;
				await this.retireRecovered(attempt);
			});
		attempt.chain = next;
		return next;
	}

	private async retireRecovered(attempt: Attempt): Promise<void> {
		if (!attempt.recovered || this.closed || (attempt.shipping ?? 0) > 0) return;
		if (this.attempts.get(attempt.lease.id) !== attempt) return;
		if (attempt.fenced === undefined) {
			if (attempt.accepted.length > 0) return;
			try {
				if ((await this.shard.pendingCount(attempt.lease)) > 0) return;
			} catch {
				return;
			}
		}
		if (
			!attempt.recovered ||
			this.closed ||
			(attempt.shipping ?? 0) > 0 ||
			this.attempts.get(attempt.lease.id) !== attempt ||
			(attempt.fenced === undefined && attempt.accepted.length > 0)
		)
			return;
		this.attempts.delete(attempt.lease.id);
		this.shard.release(attempt.lease);
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
			const elapsedMs = this.now() - began;
			const isUrgent = sealed.events.length > this.options.maxBatch;
			const timing = isUrgent ? this.urgentTiming : this.normalTiming;
			timing.note(elapsedMs, sealed.events.length);
			if (isUrgent) {
				attempt.urgentTiming ??= new DeliveryTiming();
				attempt.urgentTiming.note(elapsedMs, sealed.events.length);
			} else {
				attempt.normalTiming ??= new DeliveryTiming();
				attempt.normalTiming.note(elapsedMs, sealed.events.length);
			}
		} catch (error) {
			const fenced = await this.fence(attempt, lease, error as Error);
			if (fenced === undefined) this.lastError = error as Error;
			throw fenced ?? error;
		}
		this.lastError = undefined;
		const last = sealed.events.at(-1)!.localSeq;
		await this.shard.shipped(lease, last);
		attempt.shippedThrough = Math.max(attempt.shippedThrough, last);
		attempt.accepted = attempt.accepted.filter((entry) => entry.localSeq > attempt.shippedThrough);
	}

	private async acceptWithRenewal(
		lease: AttemptLease,
		key: string,
		payload: string,
		at: number,
		renewAttempt?: () => Promise<void>,
	): Promise<{ readonly localSeq: number; readonly accepted: boolean } | undefined> {
		const accept = () => this.shard.accept(this.shard.root, lease, key, payload, at);
		try {
			return await accept();
		} catch (error) {
			if (error instanceof StaleWorkLeaseError && error.reason === "expired" && renewAttempt !== undefined) {
				try {
					await renewAttempt();
				} catch (renewError) {
					const attempt = this.attempts.get(lease.id);
					if (attempt?.lease.generation === lease.generation)
						await this.fence(attempt, lease, renewError as Error);
					throw renewError;
				}
				if (this.isSyncOnly(lease)) return undefined;
				try {
					return await accept();
				} catch (retryError) {
					return this.acceptFailure(lease, retryError as Error);
				}
			}
			return this.acceptFailure(lease, error as Error);
		}
	}

	private acceptFailure(lease: AttemptLease, error: Error): undefined {
		if (error instanceof StaleWorkLeaseError || error instanceof ShipIdentityConflictError) throw error;
		this.fallBack(lease, error);
		return undefined;
	}

	private async commitDirect(
		lease: AttemptLease,
		commitShared: () => Promise<PoolCommitReceipt>,
	): Promise<PoolCommitReceipt> {
		const attempt = this.attempts.get(lease.id);
		await this.flush(lease);
		try {
			return await commitShared();
		} catch (error) {
			const fenced =
				attempt?.lease.generation === lease.generation
					? await this.fence(attempt, lease, error as Error)
					: undefined;
			throw fenced ?? error;
		}
	}

	private async fence(attempt: Attempt, lease: AttemptLease, error: Error): Promise<Error | undefined> {
		const workLeaseLost = error instanceof StaleWorkLeaseError && error.reason !== "expired";
		const rootLeaseLost =
			error instanceof StaleLeaseError &&
			(error.currentEpoch !== error.heldEpoch ||
				this.options.rootStanding === undefined ||
				(await this.options.rootStanding()) === "lost");
		if (!workLeaseLost && !rootLeaseLost) return undefined;
		attempt.fenced =
			error instanceof StaleWorkLeaseError
				? error
				: new StaleWorkLeaseError(
						{ root: this.shard.root, workId: lease.id, generation: lease.generation, reason: "fenced" },
						{ cause: error },
					);
		attempt.accepted = [];
		try {
			await this.shard.fence(lease);
		} catch (fenceError) {
			this.fallBack(lease, fenceError as Error);
		}
		return attempt.fenced;
	}

	private noteAccepted(lease: AttemptLease, localSeq: number): void {
		const attempt = this.attempts.get(lease.id);
		if (
			attempt === undefined ||
			attempt.lease.generation !== lease.generation ||
			attempt.fenced !== undefined ||
			localSeq <= attempt.shippedThrough
		)
			return;
		attempt.accepted.push({ localSeq, at: this.now() });
	}

	private now(): number {
		return (this.options.now ?? (() => performance.now()))();
	}

	private fallBack(lease: Pick<AttemptLease, "id" | "generation">, error: Error): void {
		if ((this.generations.get(lease.id) ?? lease.generation) > lease.generation || this.isSyncOnly(lease)) return;
		this.generations.set(lease.id, lease.generation);
		this.syncOnly.set(lease.id, lease.generation);
		this.options.onFallback?.({ workId: lease.id, error });
	}
}

/** The checkpoint as the JSON value the shared journal records, checked serializable as the shared commit checks it. */
function payloadOf(checkpoint: unknown) {
	assertWorkflowSerializableObject(checkpoint, "Pool checkpoint");
	return checkpoint;
}

function timedCatchUpMs(normal: number, normalTiming: DeliveryTiming, urgentTiming: DeliveryTiming, size: number) {
	const urgentMs = urgentTiming.averageMs!;
	const urgentSize = urgentTiming.averageSize!;
	const normalMs = normalTiming.averageMs;
	const normalSize = normalTiming.averageSize;
	if (normalMs === undefined || normalSize === undefined)
		return Math.max(urgentTiming.estimate()!, (urgentMs / urgentSize) * size);
	const marginalMs = urgentSize > normalSize ? Math.max(0, (urgentMs - normalMs) / (urgentSize - normalSize)) : 0;
	return (
		normal +
		marginalMs * Math.max(0, size - normalSize) +
		Math.max(0, urgentTiming.estimate()! - urgentMs) * (size / urgentSize)
	);
}
