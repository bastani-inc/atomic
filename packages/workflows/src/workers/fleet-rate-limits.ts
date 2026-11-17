import { randomUUID } from "node:crypto";
import type { ProviderRateLimitObservation, ProviderRequestGate } from "@bastani/atomic";
import type {
	RateAcquireOutcome,
	RateBucketPoll,
	RateBucketShape,
	RateBucketWaiting,
	RateWaitingReportOutcome,
	SqlRateBuckets,
} from "../durable/journal/sql-rate-buckets.js";
import type { FleetRateLimit, FleetRateLimits } from "./fleet-rate-types.js";
import { FleetRateWaiting } from "./fleet-rate-waiting.js";

export type { FleetRateLimit, FleetRateLimits } from "./fleet-rate-types.js";

/**
 * Fleet-wide model rate limits (#4768): every host of a shared pool draws a model call's tokens from one GCRA bucket
 * per provider or `provider/model` scope in the shared journal, and shares 429 cooldowns there. A host's coordinator
 * takes tokens in prefetched batches and hands them to its workers over IPC, so the journal sees about one acquire per
 * batch. When the journal does not answer within {@link FLEET_RATE_STORE_TIMEOUT_MS}, the host meters on a local bucket
 * at its share of the rate instead, so a model call never waits on the journal beyond that.
 */

/** The longest a model call waits on the journal for a token before the host meters locally. */
export const FLEET_RATE_STORE_TIMEOUT_MS = 1_000;

/** After the journal failed or was slow, how long a host meters locally before it asks the journal again. */
export const FLEET_RATE_STORE_RETRY_MS = 5_000;

/** How often a host reads shared cooldowns and the count of live hosts. */
export const FLEET_RATE_POLL_MS = 1_000;

/** Ten seconds' worth of requests, and at least one. */
export function defaultBurst(requestsPerMinute: number): number {
	return Math.max(1, Math.ceil(requestsPerMinute / 6));
}

/** The bucket a limit describes. */
export function bucketShape(limit: FleetRateLimit): RateBucketShape {
	return { intervalMs: 60_000 / limit.requestsPerMinute, burst: limit.burst ?? defaultBurst(limit.requestsPerMinute) };
}

/** Why `limits` is not valid `workers.rateLimits`, or undefined when it is. */
export function fleetRateLimitsProblem(limits: unknown): string | undefined {
	if (typeof limits !== "object" || limits === null || Array.isArray(limits))
		return "an object of limits by provider or provider/model";
	for (const [scope, limit] of Object.entries(limits)) {
		const slash = scope.indexOf("/");
		if (scope.trim() === "" || slash === 0 || slash === scope.length - 1)
			return `"${scope}" is not a provider id or provider/model`;
		if (typeof limit !== "object" || limit === null) return `${scope} needs { requestsPerMinute }`;
		const { requestsPerMinute, burst, prefetch } = limit as Record<string, unknown>;
		if (typeof requestsPerMinute !== "number" || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0)
			return `${scope}.requestsPerMinute must be a positive number`;
		for (const [name, value] of [
			["burst", burst],
			["prefetch", prefetch],
		] as const)
			if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))
				return `${scope}.${name} must be a positive integer`;
	}
	return undefined;
}

/** The configured scopes a call to `provider`'s `model` draws from: the provider's, then the model's. */
export function rateScopesFor(scopes: Iterable<string>, provider: string, model: string): string[] {
	const configured = new Set(scopes);
	return [provider, `${provider}/${model}`].filter((scope) => configured.has(scope));
}

/** The scope an observation covers, as rate limits name it. */
export function observationScope(observation: ProviderRateLimitObservation): string {
	return observation.model === undefined ? observation.provider : `${observation.provider}/${observation.model}`;
}

/** A cooldown as an observation workers apply, ending `remainingMs` from `now`. */
export function cooldownObservation(
	scope: string,
	remainingMs: number,
	now = Date.now(),
): ProviderRateLimitObservation {
	const slash = scope.indexOf("/");
	const untilEpochMs = Math.ceil(now + remainingMs);
	return slash < 0
		? { provider: scope, kind: "cooldown", untilEpochMs }
		: { provider: scope.slice(0, slash), model: scope.slice(slash + 1), kind: "cooldown", untilEpochMs };
}

/** A token bucket in this process (GCRA), on its clock: the store's own rule, for when the store does not answer. */
export class LocalGcra {
	private tat = 0;
	private readonly shape: RateBucketShape;
	constructor(shape: RateBucketShape) {
		this.shape = shape;
	}

	/** Takes `count` tokens and returns 0, or takes none and returns how long until one is free. */
	take(now: number, count = 1): number {
		const { intervalMs, burst } = this.shape;
		const next = Math.max(this.tat, now) + count * intervalMs;
		if (next - now <= burst * intervalMs) {
			this.tat = next;
			return 0;
		}
		return Math.max(1, Math.ceil(Math.max(this.tat, now) + intervalMs - burst * intervalMs - now));
	}

	/** Gives back `count` tokens taken but not used. */
	refund(count = 1): void {
		this.tat -= count * this.shape.intervalMs;
	}
}

type PendingWaitingReport = Omit<RateBucketWaiting, "epoch">;

interface WaitingReporter {
	readonly id: string;
	readonly baseline: number;
	reported: number;
	registration?: Promise<number>;
}

interface ScopeState {
	readonly waiting: FleetRateWaiting;
	waitingReporter: WaitingReporter;
	readonly shape: RateBucketShape;
	readonly prefetch: number;
	/** Tokens taken from the store and not handed out yet, usable until `expiresAt`. */
	tokens: number;
	expiresAt: number;
	/** Until when the store said no token is free. */
	waitUntil: number;
	/** Whether this process gave the store the scope's shape. */
	shaped: boolean;
	/** The store acquire in flight, resolving to whether it answered; concurrent requests of the scope share it. */
	fetching?: Promise<boolean>;
	/** The local bucket while the store does not answer, and when to ask the store again. */
	local?: LocalGcra;
	retryStoreAt: number;
}

export type FleetRateLimitMode = "store" | "local-fallback";

export interface FleetRateLimiterOptions {
	readonly store: SqlRateBuckets;
	readonly limits: FleetRateLimits;
	readonly shareCooldowns: boolean;
	/** This host's workers for the root: the default prefetch is half of them. */
	readonly slots: number;
	/** Shared cooldowns read from the store, to apply as limits on this host. */
	readonly applyCooldowns: (observations: readonly ProviderRateLimitObservation[]) => void;
	/** Internal, tests only. */
	readonly timeoutMs?: number;
	readonly retryStoreMs?: number;
	readonly pollMs?: number;
}

/** A host coordinator's view of the fleet's buckets for one root. */
export class FleetRateLimiter {
	private readonly scopes = new Map<string, ScopeState>();
	private readonly requests = new Map<string, Map<string, { active: boolean }>>();
	private storePoll?: Promise<RateBucketPoll>;
	private storeReport?: {
		readonly waiting: readonly PendingWaitingReport[];
		readonly result: Promise<RateWaitingReportOutcome>;
	};
	private liveHosts = 1;
	private pollTimer?: NodeJS.Timeout;
	private polling?: Promise<void>;
	private closed = false;
	private readonly timeoutMs: number;
	private readonly retryStoreMs: number;
	private readonly options: FleetRateLimiterOptions;

	constructor(options: FleetRateLimiterOptions) {
		this.options = options;
		this.timeoutMs = options.timeoutMs ?? FLEET_RATE_STORE_TIMEOUT_MS;
		this.retryStoreMs = options.retryStoreMs ?? FLEET_RATE_STORE_RETRY_MS;
		for (const [scope, limit] of Object.entries(options.limits)) {
			const shape = bucketShape(limit);
			this.scopes.set(scope, {
				waiting: new FleetRateWaiting(),
				waitingReporter: { id: randomUUID(), baseline: 0, reported: 0 },
				shape,
				prefetch: Math.min(shape.burst, limit.prefetch ?? Math.max(1, Math.ceil(options.slots / 2))),
				tokens: 0,
				expiresAt: 0,
				waitUntil: 0,
				shaped: false,
				retryStoreAt: 0,
			});
		}
	}

	/** The scopes a worker asks tokens of. */
	get rateScopes(): readonly string[] {
		return [...this.scopes.keys()];
	}

	/** `"local-fallback"` while any scope meters locally because the store did not answer. */
	get mode(): FleetRateLimitMode {
		for (const state of this.scopes.values()) if (state.local !== undefined) return "local-fallback";
		return "store";
	}

	/** Starts reading shared cooldowns and live hosts. */
	start(): void {
		const tick = () => {
			if (this.closed) return;
			this.polling = this.poll().finally(() => {
				this.polling = undefined;
				if (!this.closed) this.pollTimer = setTimeout(tick, this.options.pollMs ?? FLEET_RATE_POLL_MS).unref();
			});
		};
		tick();
	}

	async close(): Promise<void> {
		this.closed = true;
		clearTimeout(this.pollTimer);
		const now = performance.now();
		for (const worker of this.requests.keys()) this.releaseWorker(worker);
		for (const state of this.scopes.values()) state.waiting.close(now);
		await this.polling;
		if (this.waitingReports().length === 0) return;
		const pending = this.storeReport;
		if (pending !== undefined) await within(pending.result, this.timeoutMs).catch(() => undefined);
		if (this.storeReport === undefined) await this.flushWaiting().catch(() => {});
	}

	releaseRequest(worker: string, request: string): void {
		const requests = this.requests.get(worker);
		const active = requests?.get(request);
		if (active !== undefined) active.active = false;
		requests?.delete(request);
		if (requests?.size === 0) this.requests.delete(worker);
		const now = performance.now();
		for (const state of this.scopes.values()) state.waiting.releaseRequest(worker, request, now);
	}

	releaseWorker(worker: string): void {
		for (const request of this.requests.get(worker)?.values() ?? []) request.active = false;
		this.requests.delete(worker);
		const now = performance.now();
		for (const state of this.scopes.values()) state.waiting.releaseWorker(worker, now);
	}

	private waitingReports(): PendingWaitingReport[] {
		const now = performance.now();
		return [...this.scopes].flatMap(([scope, state]) => {
			const reporter = state.waitingReporter;
			const waitingMs = state.waiting.total(now) - reporter.baseline;
			return waitingMs > reporter.reported ? [{ reporter: reporter.id, scope, waitingMs }] : [];
		});
	}

	private async sendWaiting(waiting: readonly PendingWaitingReport[]): Promise<RateWaitingReportOutcome> {
		const registered = await Promise.all(
			waiting.map(async (row) => {
				const state = this.scopes.get(row.scope)!;
				const reporter = state.waitingReporter;
				if (reporter.id !== row.reporter) return;
				if (reporter.registration === undefined) {
					const registration = Promise.resolve().then(() =>
						this.options.store.registerWaiting(row.scope, row.reporter),
					);
					reporter.registration = registration;
					void registration.catch(() => {
						if (state.waitingReporter === reporter)
							state.waitingReporter = { id: randomUUID(), baseline: reporter.baseline, reported: 0 };
					});
				}
				return { ...row, epoch: await reporter.registration };
			}),
		);
		return this.options.store.reportWaiting(registered.filter((row): row is RateBucketWaiting => row !== undefined));
	}

	private async flushWaiting(): Promise<void> {
		let reporting = this.storeReport;
		if (reporting === undefined) {
			const waiting = this.waitingReports();
			if (waiting.length === 0) return;
			reporting = { waiting, result: Promise.resolve().then(() => this.sendWaiting(waiting)) };
			this.storeReport = reporting;
			const finished = () => {
				if (this.storeReport === reporting) this.storeReport = undefined;
			};
			void reporting.result.then(finished, finished);
		}
		const outcome = await within(reporting.result, this.timeoutMs);
		if (outcome === undefined) return;
		for (const row of reporting.waiting) {
			const state = this.scopes.get(row.scope)!;
			const reporter = state.waitingReporter;
			if (reporter.id !== row.reporter) continue;
			if (outcome.expired.some((entry) => entry.scope === row.scope && entry.reporter === row.reporter)) {
				state.waitingReporter = { id: randomUUID(), baseline: reporter.baseline + row.waitingMs, reported: 0 };
			} else reporter.reported = Math.max(reporter.reported, row.waitingMs);
		}
	}

	private async readStatus(): Promise<void> {
		let polling = this.storePoll;
		if (polling === undefined) {
			polling = Promise.resolve().then(() => this.options.store.poll());
			this.storePoll = polling;
			const finished = () => {
				if (this.storePoll === polling) this.storePoll = undefined;
			};
			void polling.then(finished, finished);
		}
		const report = await within(polling, this.timeoutMs);
		if (report === undefined) return;
		this.liveHosts = Math.max(1, report.liveHosts);
		if (this.options.shareCooldowns && report.cooldowns.length > 0) {
			const now = Date.now();
			this.options.applyCooldowns(
				report.cooldowns.map((cooldown) => cooldownObservation(cooldown.scope, cooldown.remainingMs, now)),
			);
		}
	}

	async poll(): Promise<void> {
		await Promise.all([this.readStatus().catch(() => {}), this.flushWaiting().catch(() => {})]);
	}

	/** Shares a 429 cooldown this host recorded with every host of the fleet, when the root shares cooldowns. */
	shareCooldown(observation: ProviderRateLimitObservation): void {
		if (!this.options.shareCooldowns || observation.kind !== "cooldown") return;
		const remainingMs = observation.untilEpochMs - Date.now();
		if (remainingMs <= 0) return;
		// Best effort: a host that cannot reach the store still holds its own processes back.
		void this.options.store.cooldown(observationScope(observation), remainingMs).catch(() => {});
	}

	/**
	 * Takes one token of each configured scope a call to `provider`'s `model` draws from, and returns 0; or takes none
	 * and returns how long the call waits before it asks again. Never waits on the store beyond the timeout.
	 */
	async acquire(provider: string, model: string, worker = "host", request = "default"): Promise<number> {
		if (this.closed) return 0;
		let requests = this.requests.get(worker);
		if (requests === undefined) {
			requests = new Map();
			this.requests.set(worker, requests);
		}
		let active = requests.get(request);
		if (active === undefined) {
			active = { active: true };
			requests.set(request, active);
		}
		const taken: ScopeState[] = [];
		for (const scope of rateScopesFor(this.scopes.keys(), provider, model)) {
			const state = this.scopes.get(scope)!;
			const waitMs = await this.take(scope, state);
			if (!active.active) {
				if (waitMs === 0) this.refund(state);
				for (const held of taken) this.refund(held);
				return 0;
			}
			if (waitMs > 0) {
				state.waiting.record(worker, request, Math.min(waitMs, GATE_MAX_WAIT_MS), performance.now());
				for (const held of taken) this.refund(held);
				return waitMs;
			}
			taken.push(state);
		}
		this.releaseRequest(worker, request);
		return 0;
	}

	private refund(state: ScopeState): void {
		if (state.local !== undefined) state.local.refund();
		else state.tokens++;
	}

	private async take(scope: string, state: ScopeState): Promise<number> {
		let now = Date.now();
		if (state.tokens > 0 && state.expiresAt <= now) state.tokens = 0;
		if (state.tokens > 0) {
			state.tokens--;
			return 0;
		}
		if (state.waitUntil > now) return state.waitUntil - now;
		if (state.local !== undefined) {
			// Metering locally: the store is asked again in the background, and takes over once it answers.
			if (state.fetching === undefined && now >= state.retryStoreAt) this.startFetch(scope, state);
			return this.takeLocally(state, now);
		}
		const answered = await within(state.fetching ?? this.startFetch(scope, state), this.timeoutMs);
		now = Date.now();
		if (answered !== true) return this.takeLocally(state, now);
		if (state.tokens > 0) {
			state.tokens--;
			return 0;
		}
		return Math.max(1, state.waitUntil - now);
	}

	/**
	 * Asks the store for the scope's next batch. Answered, it ends the local fallback; failed or slower than the
	 * timeout, it starts or keeps the fallback and the store is asked again after the retry wait. A slow request that
	 * answers later still keeps its tokens, so nothing the store granted is lost.
	 */
	private startFetch(scope: string, state: ScopeState): Promise<boolean> {
		const fetching: Promise<boolean> = this.fetch(scope, state).then(
			() => {
				state.local = undefined;
				if (state.fetching === fetching) state.fetching = undefined;
				return true;
			},
			() => {
				if (state.fetching === fetching) state.fetching = undefined;
				this.fallBack(state);
				return false;
			},
		);
		state.fetching = fetching;
		const timer = setTimeout(() => {
			if (state.fetching !== fetching) return;
			// No longer waited on: the next ask after the retry wait sends a request of its own.
			state.fetching = undefined;
			this.fallBack(state);
		}, this.timeoutMs);
		timer.unref?.();
		void fetching.then(() => clearTimeout(timer));
		return fetching;
	}

	private fallBack(state: ScopeState): void {
		state.retryStoreAt = Date.now() + this.retryStoreMs;
		this.localBucket(state);
	}

	/** The scope's local bucket: this host's share of the fleet's rate, the rate divided by the live hosts. */
	private localBucket(state: ScopeState): LocalGcra {
		state.local ??= new LocalGcra({
			intervalMs: state.shape.intervalMs * Math.max(1, this.liveHosts),
			burst: state.shape.burst,
		});
		return state.local;
	}

	private takeLocally(state: ScopeState, now: number): number {
		return this.localBucket(state).take(now);
	}

	private async fetch(scope: string, state: ScopeState): Promise<void> {
		let count = state.prefetch;
		for (let tries = 0; tries < 2; tries++) {
			const outcome: RateAcquireOutcome = await this.options.store.acquire(
				scope,
				count,
				state.shaped ? undefined : state.shape,
			);
			state.shaped = true;
			const now = Date.now();
			if (outcome.granted > 0) {
				state.tokens += outcome.granted;
				state.expiresAt = now + Math.max(1_000, state.shape.burst * state.shape.intervalMs);
				state.waitUntil = 0;
				return;
			}
			if (!("waitMs" in outcome)) return;
			// Fewer tokens than asked may fit now: ask for those once.
			if (outcome.waitMs === 0 && outcome.fits < count) {
				count = outcome.fits;
				continue;
			}
			state.waitUntil = now + Math.max(1, outcome.waitMs);
			return;
		}
	}
}

/** The value of `promise`, or undefined once `ms` elapses. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The longest one wait between two asks for a token. */
const GATE_MAX_WAIT_MS = 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Provider request aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/**
 * The gate a pooled worker's model calls wait on (#4768): a call to a configured scope asks the coordinator for a token,
 * through `ask`, and waits as long as the reply says before asking again. A coordinator that cannot answer lets the call
 * go: the fleet's limit never fails a call.
 */
export function fleetRateGate(
	scopes: readonly string[],
	ask: (provider: string, model: string, request: string) => Promise<unknown>,
	release?: (request: string) => Promise<unknown>,
): ProviderRequestGate {
	let sequence = 0;
	return async (provider, model, signal) => {
		if (rateScopesFor(scopes, provider, model).length === 0) return;
		const request = String(++sequence);
		let released = false;
		const finish = () => {
			if (released) return;
			released = true;
			void release?.(request).catch(() => {});
		};
		signal?.addEventListener("abort", finish, { once: true });
		try {
			for (;;) {
				signal?.throwIfAborted();
				let waitMs: number;
				try {
					const reply = await ask(provider, model, request);
					waitMs = typeof reply === "number" && Number.isFinite(reply) && reply > 0 ? reply : 0;
				} catch {
					return;
				}
				if (waitMs === 0) return;
				await sleep(Math.min(waitMs, GATE_MAX_WAIT_MS), signal);
			}
		} finally {
			signal?.removeEventListener("abort", finish);
			finish();
		}
	};
}
