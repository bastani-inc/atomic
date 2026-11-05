import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { defaultWorkerHeartbeatMs } from "../../packages/workflows/src/workers/worker-timing.js";
import {
	assertNoLapse,
	assertRenewedBeforeExpiry,
	coalescedWorker,
	LEGACY_HEARTBEAT_INTERVAL_MS,
	legacyWorker,
	type SimulatedPool,
	type SimulatedWorker,
	simulatedPool,
	usageAt,
} from "../helpers/pool-heartbeat-simulation.js";

/**
 * Pool reads run on a read-only connection the journal opens itself (#4314). Every SQLite connection in this file reads
 * its clock from `Date`, so that connection follows the simulation's fake clock as the journal's own connection does.
 */
vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class DateClockedDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => Date.now() / 1_000);
		}
	}
	return { ...actual, DatabaseSync: DateClockedDatabase };
});

/** Workers of one pool, as many as #4312 measured per coordinator. */
const WORKERS = 450;
/** The lease #4312's pools ran with. */
const LEASE_MS = 60_000;
/** Measured window of each run: eight heartbeats of a 60 s lease, 120 of the legacy heartbeat. */
const WINDOW_MS = 120_000;
/** The clock moves in steps this long; every heartbeat interval is a multiple of it. */
const STEP_MS = 500;
/** The reduction #4313 requires of heartbeat-driven journal writes per second. */
const REQUIRED_REDUCTION = 10;
/**
 * Structural cost: hundreds of simulated workers and the ~160,000 journal requests of the legacy heartbeat over the
 * window, run for real against SQLite.
 */
const HUNDREDS_OF_WORKERS_BENCHMARK_TIMEOUT_MS = 300_000;

interface WindowMeasurement {
	readonly transactions: number;
	readonly perSecond: number;
	readonly requests: number;
	readonly totalUsage: Awaited<ReturnType<SimulatedPool["usage"]["total"]>>;
}

/** Runs `workers` over the measured window, then flushes their final usage as an attempt's end does. */
async function measureWindow(
	pool: SimulatedPool,
	workers: readonly SimulatedWorker[],
	finalReport: (worker: SimulatedWorker) => Promise<unknown>,
): Promise<WindowMeasurement> {
	pool.measuring = true;
	await pool.advance(WINDOW_MS, STEP_MS);
	pool.measuring = false;
	const transactions = pool.transactions;
	await Promise.all(workers.map((worker) => worker.stop()));
	for (const worker of workers) await finalReport(worker);
	return {
		transactions,
		perSecond: transactions / (WINDOW_MS / 1_000),
		requests: workers.reduce((sum, worker) => sum + worker.requests, 0),
		totalUsage: await pool.usage.total("root"),
	};
}

test(
	"a coalesced, lease-derived heartbeat cuts 450 workers' heartbeat journal writes per second by at least 10x with no lease lapse (#4313)",
	async () => {
		const legacyPool = await simulatedPool(WORKERS, LEASE_MS);
		let legacy: WindowMeasurement;
		try {
			const workers = Array.from({ length: WORKERS }, (_, index) => legacyWorker(legacyPool, index));
			legacy = await measureWindow(legacyPool, workers, (worker) =>
				legacyPool.usage.report(legacyPool.lease, worker.held, usageAt(worker.index, WINDOW_MS)),
			);
		} finally {
			await legacyPool.close();
		}

		const pool = await simulatedPool(WORKERS, LEASE_MS);
		const intervalMs = defaultWorkerHeartbeatMs(LEASE_MS);
		try {
			const workers = Array.from({ length: WORKERS }, (_, index) => coalescedWorker(pool, index, intervalMs));
			let minimumHeadroomMs = Number.POSITIVE_INFINITY;
			pool.measuring = true;
			await pool.advance(WINDOW_MS, STEP_MS, async () => {
				minimumHeadroomMs = Math.min(minimumHeadroomMs, await assertNoLapse(pool, workers));
			});
			pool.measuring = false;
			const transactions = pool.transactions;
			await Promise.all(workers.map((worker) => worker.stop()));
			const longestRenewalGapMs = assertRenewedBeforeExpiry(pool, workers);
			for (const worker of workers) {
				const record = pool.usage.recording(pool.lease, worker.held, usageAt(worker.index, WINDOW_MS));
				await pool.queue.heartbeat(pool.lease, worker.held, LEASE_MS, record);
			}
			const coalesced: WindowMeasurement = {
				transactions,
				perSecond: transactions / (WINDOW_MS / 1_000),
				requests: workers.reduce((sum, worker) => sum + worker.requests, 0),
				totalUsage: await pool.usage.total("root"),
			};
			const heartbeatsPerWorker = Math.floor(WINDOW_MS / intervalMs);
			console.log(
				`[pool heartbeat cost #4313] ${JSON.stringify({
					workers: WORKERS,
					leaseMs: LEASE_MS,
					windowMs: WINDOW_MS,
					legacy: { intervalMs: LEGACY_HEARTBEAT_INTERVAL_MS, ...legacy, totalUsage: undefined },
					coalesced: { intervalMs, ...coalesced, totalUsage: undefined },
					reduction: legacy.perSecond / coalesced.perSecond,
					longestRenewalGapMs,
					minimumHeadroomMs,
				})}`,
			);

			assert.equal(intervalMs, 15_000, "a 60 s lease is renewed every 15 s");
			assert.equal(legacy.requests, WORKERS * 3 * (WINDOW_MS / LEGACY_HEARTBEAT_INTERVAL_MS));
			assert.equal(
				legacy.transactions,
				WORKERS * 2 * (WINDOW_MS / LEGACY_HEARTBEAT_INTERVAL_MS),
				"the legacy heartbeat cost a transaction per renewal and per usage report, and its control poll is a read (#4314)",
			);
			assert.equal(coalesced.requests, WORKERS * heartbeatsPerWorker, "one coalesced request per heartbeat");
			assert.equal(coalesced.transactions, coalesced.requests, "one journal transaction per coalesced heartbeat");
			assert.ok(
				legacy.perSecond >= REQUIRED_REDUCTION * coalesced.perSecond,
				`heartbeat writes fell from ${legacy.perSecond}/s to ${coalesced.perSecond}/s, less than ${REQUIRED_REDUCTION}x`,
			);
			for (const worker of workers)
				assert.equal(worker.maxInFlight, 1, `worker ${worker.index} overlapped heartbeats`);
			assert.ok(longestRenewalGapMs <= intervalMs, `an attempt went ${longestRenewalGapMs} ms between renewals`);
			assert.ok(minimumHeadroomMs >= LEASE_MS - intervalMs, `a lease came within ${minimumHeadroomMs} ms of expiry`);
			assert.deepEqual(coalesced.totalUsage, legacy.totalUsage, "both heartbeats account the same usage");
			assert.ok(coalesced.totalUsage.input > 0, "the workers reported usage");
		} finally {
			await pool.close();
		}
	},
	HUNDREDS_OF_WORKERS_BENCHMARK_TIMEOUT_MS,
);
