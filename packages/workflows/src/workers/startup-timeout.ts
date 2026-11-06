import { availableParallelism, loadavg } from "node:os";

export const BASE_STARTUP_TIMEOUT_MS = 30_000;
export const MAX_DEFAULT_STARTUP_TIMEOUT_MS = 600_000;

export interface HostCapacity {
	readonly cpus: number;
	readonly load: number;
}

function currentHostCapacity(): HostCapacity {
	return { cpus: availableParallelism(), load: loadavg()[0] ?? 0 };
}

export function defaultStartupTimeoutMs(workers: number, host: HostCapacity = currentHostCapacity()): number {
	const cores = Math.max(1, host.cpus);
	const demand = workers + Math.max(0, host.load);
	const oversubscription = Math.max(1, demand / cores);
	return Math.min(MAX_DEFAULT_STARTUP_TIMEOUT_MS, Math.ceil(BASE_STARTUP_TIMEOUT_MS * oversubscription));
}

/**
 * How long a worker that missed its startup deadline was waited for, from its spawn to when the deadline's timer
 * fired. The timer runs on the event loop's clock, which can read slightly behind the spawn, so the result is never
 * less than the deadline it fired for.
 */
export function startupWaitedMs(timeoutMs: number, spawnedAt: number, firedAt: number): number {
	return Math.max(timeoutMs, Math.round(firedAt - spawnedAt));
}
