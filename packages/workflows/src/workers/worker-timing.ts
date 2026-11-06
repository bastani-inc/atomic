import {
	LocalWorkerOptionsError,
	type LocalWorkerOptionsSource,
	type LocalWorkerTimingOption,
} from "../shared/worker-pool-errors.js";

/** Longest delay a timer accepts. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** How long a worker that stopped answering keeps its child when `localWorkers.leaseMs` is unset. */
export const DEFAULT_WORK_LEASE_MS = 30_000;
export const MINIMUM_WORK_LEASE_MS = 2_000;
/** Shortest `localWorkers.heartbeatMs`. */
export const MINIMUM_WORKER_HEARTBEAT_MS = 100;
/** Heartbeats per work lease when `localWorkers.heartbeatMs` is unset: three can be late before the lease runs out. */
export const WORK_LEASE_HEARTBEATS = 4;

/** The heartbeat interval a lease gets when `localWorkers.heartbeatMs` is unset: 15 s for a 60 s lease. */
export function defaultWorkerHeartbeatMs(leaseMs: number): number {
	return Math.floor(leaseMs / WORK_LEASE_HEARTBEATS);
}

export interface WorkerTiming {
	readonly leaseMs: number;
	readonly heartbeatMs: number;
}

function received(value: unknown): string {
	return typeof value === "number" ? String(value) : (JSON.stringify(value) ?? typeof value);
}

function checkRange(
	value: number,
	option: LocalWorkerTimingOption,
	minimum: number,
	maximum: number,
	omitted: string,
	source: LocalWorkerOptionsSource,
): void {
	const reason = !Number.isSafeInteger(value)
		? "not-an-integer"
		: value < minimum
			? "below-minimum"
			: value > maximum
				? "above-maximum"
				: undefined;
	if (reason !== undefined)
		throw new LocalWorkerOptionsError({
			source,
			option,
			reason,
			received: received(value),
			minimum,
			maximum,
			omitted,
		});
}

/**
 * A pool's work lease and worker heartbeat interval, from its `localWorkers` settings. The lease is an integer from
 * {@link MINIMUM_WORK_LEASE_MS} to {@link MAX_TIMER_DELAY_MS}, {@link DEFAULT_WORK_LEASE_MS} when unset. The heartbeat
 * is an integer from {@link MINIMUM_WORKER_HEARTBEAT_MS} to half the lease, a quarter of the lease when unset. Throws
 * {@link LocalWorkerOptionsError} naming `source` for a value out of range.
 */
export function resolveWorkerTiming(
	options: { readonly leaseMs?: number; readonly heartbeatMs?: number },
	source: LocalWorkerOptionsSource,
): WorkerTiming {
	if (options.leaseMs !== undefined)
		checkRange(
			options.leaseMs,
			"leaseMs",
			MINIMUM_WORK_LEASE_MS,
			MAX_TIMER_DELAY_MS,
			`for the ${DEFAULT_WORK_LEASE_MS} ms default`,
			source,
		);
	const leaseMs = options.leaseMs ?? DEFAULT_WORK_LEASE_MS;
	if (options.heartbeatMs !== undefined)
		checkRange(
			options.heartbeatMs,
			"heartbeatMs",
			MINIMUM_WORKER_HEARTBEAT_MS,
			Math.floor(leaseMs / 2),
			`to send ${WORK_LEASE_HEARTBEATS} heartbeats per lease`,
			source,
		);
	return { leaseMs, heartbeatMs: options.heartbeatMs ?? defaultWorkerHeartbeatMs(leaseMs) };
}
