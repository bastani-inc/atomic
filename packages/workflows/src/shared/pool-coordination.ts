import { isDebugEnabled } from "@bastani/atomic";
import type { PoolCoordinationCount, PoolCoordinationStats, RunPoolSnapshot } from "./store-types.js";

/** Kinds a pool line names, busiest first; the rest are summed into the total only. */
const NAMED_KINDS = 3;

function rate(perSecond: number): string {
	return perSecond >= 10 ? perSecond.toFixed(0) : perSecond >= 1 ? perSecond.toFixed(1) : perSecond.toFixed(2);
}

function rates(counts: Readonly<Record<string, PoolCoordinationCount>>): string {
	const kinds = Object.entries(counts).sort(([, a], [, b]) => b.perSecond - a.perSecond);
	const total = kinds.reduce((sum, [, count]) => sum + count.perSecond, 0);
	if (kinds.length === 0) return `${rate(total)}/s`;
	const named = kinds.slice(0, NAMED_KINDS).map(([kind, count]) => `${kind} ${rate(count.perSecond)}`);
	return `${rate(total)}/s (${named.join(", ")}${kinds.length > NAMED_KINDS ? ", …" : ""})`;
}

/**
 * One status line for a root's local worker pool: its coordinator's requests and journal writes per second since it
 * started, with the busiest kinds named, such as `pool: requests 12/s (commit 8.1, activity 3.0, heartbeat 0.40, …) ·
 * writes 3.1/s (commit 2.7, heartbeat 0.40)`.
 */
export function formatPoolCoordination(stats: PoolCoordinationStats): string {
	return `pool: requests ${rates(stats.requests)} · writes ${rates(stats.writes)}`;
}

/** A run's pool line for status views, shown only while pool debugging is on. */
export function poolCoordinationLine(pool: RunPoolSnapshot | undefined): string | undefined {
	return pool !== undefined && isDebugEnabled("pool") ? formatPoolCoordination(pool.coordination) : undefined;
}
