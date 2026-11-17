import type { FleetRootRow } from "../durable/journal/sql-fleet.js";
import type { RateBucketUsage } from "../durable/journal/sql-rate-buckets.js";

export const RATE_CAP_WINDOW_MS = 600_000;
export const RATE_CAP_MIN_SPAN_MS = 60_000;
export const RATE_CAP_SATURATED = 0.95;

interface RateSample {
	readonly at: number;
	readonly acquired: number;
	readonly busy: number;
	readonly intervalMs: number;
}

export interface FleetRateCapScope {
	readonly scope: string;
	readonly requestsPerMinute: number;
	readonly usedPerMinute: number;
	readonly busyWorkers: number;
	readonly capHosts: number;
}

export interface FleetRateCapEstimate {
	readonly hosts: number;
	readonly scope: FleetRateCapScope;
}

export type FleetRateRoot = Pick<FleetRootRow, "leased" | "rateScopes">;

export class FleetRateCap {
	private readonly samples = new Map<string, RateSample[]>();

	observe(usage: readonly RateBucketUsage[], roots: readonly FleetRateRoot[]): void {
		const busy = new Map<string, number>();
		for (const root of roots)
			for (const scope of root.rateScopes ?? []) busy.set(scope, (busy.get(scope) ?? 0) + root.leased);
		const seen = new Set<string>();
		for (const row of usage) {
			const running = busy.get(row.scope);
			if (running === undefined || !(row.intervalMs > 0)) continue;
			seen.add(row.scope);
			const sample = { at: row.now, acquired: row.acquired, busy: running, intervalMs: row.intervalMs };
			const history = this.samples.get(row.scope) ?? [];
			const last = history.at(-1);
			if (last !== undefined && (row.acquired < last.acquired || row.now < last.at)) history.length = 0;
			if (last !== undefined && history.length > 0 && row.now === last.at) history[history.length - 1] = sample;
			else history.push(sample);
			const start = row.now - RATE_CAP_WINDOW_MS;
			while (history.length > 2 && history[1]!.at <= start) history.shift();
			this.samples.set(row.scope, history);
		}
		for (const scope of [...this.samples.keys()]) if (!seen.has(scope)) this.samples.delete(scope);
	}

	estimate(workersPerHost: number): FleetRateCapEstimate | undefined {
		let tightest: FleetRateCapEstimate | undefined;
		for (const [scope, history] of this.samples) {
			const first = history[0];
			const last = history.at(-1);
			if (first === undefined || last === undefined) continue;
			const span = last.at - first.at;
			const used = last.acquired - first.acquired;
			if (span < RATE_CAP_MIN_SPAN_MS || used <= 0) continue;
			let weighted = 0;
			for (let index = 0; index < history.length - 1; index++)
				weighted += history[index]!.busy * (history[index + 1]!.at - history[index]!.at);
			const busyWorkers = weighted / span;
			if (!(busyWorkers > 0)) continue;
			const limitPerMs = 1 / last.intervalMs;
			const utilization = Math.min(1, used / span / limitPerMs);
			const share = utilization >= RATE_CAP_SATURATED ? 1 : utilization;
			const capHosts = Math.max(1, Math.ceil(busyWorkers / share / workersPerHost));
			const estimate = {
				hosts: capHosts,
				scope: {
					scope,
					requestsPerMinute: limitPerMs * 60_000,
					usedPerMinute: (used / span) * 60_000,
					busyWorkers,
					capHosts,
				},
			};
			if (tightest === undefined || capHosts < tightest.hosts) tightest = estimate;
		}
		return tightest;
	}
}

export function rateCapReason(estimate: FleetRateCapEstimate, wanted: number): string {
	const { scope } = estimate;
	const round = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
	return `rate limit ${scope.scope} (${round(scope.requestsPerMinute)}/min) granted ${round(scope.usedPerMinute)}/min to ${round(scope.busyWorkers)} busy workers over the last ${Math.round(RATE_CAP_WINDOW_MS / 60_000)} minutes: it feeds at most ${estimate.hosts} hosts, while the queue wants ${wanted}`;
}
