import type { FleetRootRow } from "../durable/journal/sql-fleet.js";
import type { RateBucketUsage } from "../durable/journal/sql-rate-buckets.js";
import { fleetDemand } from "./autoscaler.js";

export const RATE_CAP_WINDOW_MS = 600_000;
export const RATE_CAP_MIN_SPAN_MS = 60_000;
export const RATE_CAP_MAX_GAP_MS = 30_000;
export const RATE_CAP_SATURATED = 0.95;

interface RateSample {
	readonly at: number;
	readonly acquired: number;
	readonly waitingMs: number;
	readonly busy: number;
	readonly intervalMs: number;
}

export interface FleetRateCapScope {
	readonly scope: string;
	readonly requestsPerMinute: number;
	readonly usedPerMinute: number;
	readonly busyWorkers: number;
	readonly activeWorkers: number;
	readonly spanMs: number;
	readonly capHosts: number;
}

export interface FleetRateCapEstimate {
	readonly hosts: number;
	readonly scope: FleetRateCapScope;
}

export type FleetRateRoot = Pick<FleetRootRow, "ready" | "leased" | "blocked" | "sessionLimit" | "rateScopes">;

interface ScopeCapacity {
	readonly status: FleetRateCapScope;
	readonly workers: number;
}

export class FleetRateCap {
	private readonly samples = new Map<string, RateSample[]>();
	private roots: readonly FleetRateRoot[] = [];

	constructor(private readonly maxGapMs = RATE_CAP_MAX_GAP_MS) {}

	observe(usage: readonly RateBucketUsage[], roots: readonly FleetRateRoot[]): void {
		this.roots = roots;
		const busy = new Map<string, number>();
		for (const root of roots)
			for (const scope of root.rateScopes ?? []) busy.set(scope, (busy.get(scope) ?? 0) + root.leased);
		const at = usage[0]?.now ?? Date.now();
		const readings = new Map(usage.map((row) => [row.scope, row]));
		for (const [scope, running] of busy) {
			const row = readings.get(scope);
			const sample: RateSample = {
				at: row?.now ?? at,
				acquired: row?.acquired ?? 0,
				waitingMs: row?.waitingMs ?? 0,
				busy: running,
				intervalMs: row?.intervalMs ?? 0,
			};
			const history = this.samples.get(scope) ?? [];
			const last = history.at(-1);
			if (
				last !== undefined &&
				(sample.acquired < last.acquired ||
					sample.waitingMs < last.waitingMs ||
					sample.at < last.at ||
					sample.at - last.at > this.maxGapMs ||
					sample.intervalMs !== last.intervalMs)
			)
				history.length = 0;
			if (last !== undefined && history.length > 0 && sample.at === last.at) history[history.length - 1] = sample;
			else history.push(sample);
			const start = sample.at - RATE_CAP_WINDOW_MS;
			while (
				history.length > 2 &&
				(history[1]!.at <= start ||
					(history[1]!.acquired === history[0]!.acquired && history[1]!.waitingMs === history[0]!.waitingMs))
			)
				history.shift();
			this.samples.set(scope, history);
		}
		for (const scope of this.samples.keys()) if (!busy.has(scope)) this.samples.delete(scope);
	}

	private warmingScopes(): Set<string> {
		return new Set(
			[...this.samples].flatMap(([scope, history]) =>
				history.at(-1)!.intervalMs <= 0 || history.at(-1)!.at - history[0]!.at < RATE_CAP_MIN_SPAN_MS
					? [scope]
					: [],
			),
		);
	}

	private constrainedDemand(
		capacities: readonly ScopeCapacity[],
		warming: ReadonlySet<string> = new Set(),
		warmingWorkers = 0,
		bootstrapWorkers = 1,
	): number {
		const demand = this.roots.map((root) => fleetDemand([root]));
		const constrain = (matches: (root: FleetRateRoot) => boolean, capacity: number) => {
			const selected = this.roots.flatMap((root, index) => (matches(root) ? [index] : []));
			const wanted = selected.reduce((sum, index) => sum + demand[index]!, 0);
			if (wanted > capacity) for (const index of selected) demand[index] = (demand[index]! * capacity) / wanted;
		};
		for (const capacity of capacities)
			constrain((root) => root.rateScopes?.includes(capacity.status.scope) === true, capacity.workers);
		if (warming.size > 0) {
			const isWarming = (root: FleetRateRoot) => root.rateScopes?.some((scope) => warming.has(scope)) === true;
			const unrelated = this.roots.reduce((sum, root, index) => sum + (isWarming(root) ? 0 : demand[index]!), 0);
			constrain(isWarming, Math.max(bootstrapWorkers, warmingWorkers - unrelated));
		}
		return demand.reduce((sum, value) => sum + value, 0);
	}

	limit(workersPerHost: number, servingHosts: number): number | undefined {
		const capacities = this.capacities(workersPerHost);
		const warming = this.warmingScopes();
		if (capacities.length === 0 && warming.size === 0) return undefined;
		return Math.max(
			1,
			Math.ceil(
				this.constrainedDemand(capacities, warming, Math.max(1, servingHosts) * workersPerHost, workersPerHost) /
					workersPerHost,
			),
		);
	}

	estimate(workersPerHost: number): FleetRateCapEstimate | undefined {
		const capacities = this.capacities(workersPerHost);
		const tightest = [...capacities].sort((a, b) => a.workers - b.workers)[0];
		if (tightest === undefined) return undefined;
		const hosts = Math.max(1, Math.ceil(this.constrainedDemand(capacities) / workersPerHost));
		return { hosts, scope: { ...tightest.status, capHosts: hosts } };
	}

	private capacities(workersPerHost: number): ScopeCapacity[] {
		const capacities: ScopeCapacity[] = [];
		for (const [scope, history] of [...this.samples].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			const first = history[0];
			const last = history.at(-1);
			if (first === undefined || last === undefined || !(last.intervalMs > 0)) continue;
			const span = last.at - first.at;
			const used = last.acquired - first.acquired;
			const waiting = last.waitingMs - first.waitingMs;
			if (span < RATE_CAP_MIN_SPAN_MS || (used <= 0 && waiting <= 0)) continue;
			let weighted = 0;
			for (let index = 0; index < history.length - 1; index++)
				weighted += history[index]!.busy * (history[index + 1]!.at - history[index]!.at);
			const busyWorkers = weighted / span;
			if (!(busyWorkers > 0)) continue;
			const activeWorkers = Math.max(0, busyWorkers - waiting / span);
			const limitPerMs = 1 / last.intervalMs;
			const utilization = Math.min(1, used / span / limitPerMs);
			const share = utilization >= RATE_CAP_SATURATED ? 1 : utilization;
			const workers = used <= 0 ? 1 : Math.max(1, activeWorkers / share);
			capacities.push({
				workers,
				status: {
					scope,
					requestsPerMinute: limitPerMs * 60_000,
					usedPerMinute: (used / span) * 60_000,
					busyWorkers,
					activeWorkers,
					spanMs: span,
					capHosts: Math.max(1, Math.ceil(workers / workersPerHost)),
				},
			});
		}
		return capacities;
	}
}

export function rateCapReason(estimate: FleetRateCapEstimate, wanted: number): string {
	const { scope } = estimate;
	const round = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
	return `rate limit ${scope.scope} (${round(scope.requestsPerMinute)}/min) granted ${round(scope.usedPerMinute)}/min with ${round(scope.activeWorkers)} nonwaiting workers out of ${round(scope.busyWorkers)} busy over the last ${Math.round(scope.spanMs / 1_000)} seconds: the fleet can use at most ${estimate.hosts} hosts including other scopes, while the queue wants ${wanted}`;
}
