import type { ProviderRateLimitObservation } from "@bastani/atomic";

/** A provider or model limit is sent on at most this often, and only when it grew. */
export const RATE_LIMIT_SHARE_INTERVAL_MS = 250;

function scopeKey(observation: ProviderRateLimitObservation): string {
	return `${observation.kind}\0${observation.provider}\0${observation.model ?? ""}`;
}

/** The latest end of each provider and model limit, merged from every process of a pool. */
export class RateLimitObservationSet {
	private readonly limits = new Map<string, ProviderRateLimitObservation>();

	/** Keeps the later end of the observation's scope; returns whether the observation extended it. */
	merge(observation: ProviderRateLimitObservation): boolean {
		if (!Number.isFinite(observation.untilEpochMs) || observation.untilEpochMs <= Date.now()) return false;
		const key = scopeKey(observation);
		const known = this.limits.get(key);
		if (known !== undefined && known.untilEpochMs >= observation.untilEpochMs) return false;
		this.limits.set(key, observation);
		return true;
	}

	/** Limits that have not ended yet. */
	current(): ProviderRateLimitObservation[] {
		const now = Date.now();
		for (const [key, observation] of this.limits) if (observation.untilEpochMs <= now) this.limits.delete(key);
		return [...this.limits.values()];
	}
}

/**
 * Coalesces observations before they cross a process boundary: per provider or model scope, the first
 * one goes at once and later ones at most every {@link RATE_LIMIT_SHARE_INTERVAL_MS}, carrying only the
 * latest end. An observation that does not extend what this outbox already sent or holds is dropped.
 */
export class RateLimitObservationOutbox {
	private readonly sent = new Map<string, { readonly at: number; readonly until: number }>();
	private readonly pending = new Map<string, ProviderRateLimitObservation>();
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly send: (observations: readonly ProviderRateLimitObservation[]) => void,
		private readonly intervalMs = RATE_LIMIT_SHARE_INTERVAL_MS,
	) {}

	offer(observation: ProviderRateLimitObservation): void {
		const key = scopeKey(observation);
		const held = this.pending.get(key);
		const last = this.sent.get(key);
		if (observation.untilEpochMs <= Math.max(held?.untilEpochMs ?? 0, last?.until ?? 0)) return;
		const now = Date.now();
		if (held === undefined && (last === undefined || now - last.at >= this.intervalMs)) {
			this.sent.set(key, { at: now, until: observation.untilEpochMs });
			this.send([observation]);
			return;
		}
		this.pending.set(key, observation);
		this.schedule();
	}

	close(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	private schedule(): void {
		if (this.timer !== undefined) return;
		const now = Date.now();
		let due = Number.POSITIVE_INFINITY;
		for (const key of this.pending.keys()) due = Math.min(due, (this.sent.get(key)?.at ?? now) + this.intervalMs);
		if (due === Number.POSITIVE_INFINITY) return;
		this.timer = setTimeout(() => this.flush(), Math.max(0, due - now));
		this.timer.unref?.();
	}

	private flush(): void {
		this.timer = undefined;
		const now = Date.now();
		const due: ProviderRateLimitObservation[] = [];
		for (const [key, observation] of this.pending) {
			if (now - (this.sent.get(key)?.at ?? 0) < this.intervalMs) continue;
			this.pending.delete(key);
			this.sent.set(key, { at: now, until: observation.untilEpochMs });
			due.push(observation);
		}
		for (const [key, sent] of this.sent)
			if (sent.until <= now && !this.pending.has(key) && now - sent.at >= this.intervalMs) this.sent.delete(key);
		if (due.length > 0) this.send(due);
		this.schedule();
	}
}
