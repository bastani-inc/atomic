/**
 * A real pool's workers heartbeat once every `heartbeatMs`, and the root run's `pool.coordination` shows it (#4313):
 * one request and one journal write per heartbeat, where a worker used to send a renewal, a control poll and a usage
 * report every second. A worker stopped for less than its lease's slack keeps its child; one stopped past its lease
 * loses it to a replacement.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolCoordinationStats } from "../../packages/workflows/src/shared/store-types.js";
import { sleep } from "../helpers/runtime.js";
import { fixture, SINGLE_POOL, THREE_WORKERS, waitUntil } from "../helpers/workflow-local-pool-lifecycle.js";

const LEASE_MS = 4_000;
const HEARTBEAT_MS = 250;
/** Heartbeats observed between the two samples of the pool's counts. */
const OBSERVED_HEARTBEATS = 4;
/** Requests a worker sent per heartbeat before #4313: a renewal, a control poll and a usage report. */
const LEGACY_REQUESTS_PER_HEARTBEAT = 3;

function heartbeatTraffic(stats: PoolCoordinationStats) {
	const count = (kind: string) => stats.requests[kind]?.count ?? 0;
	return {
		heartbeats: count("heartbeat"),
		heartbeatWrites: stats.writes.heartbeat?.count ?? 0,
		heartbeatDrivenRequests: count("heartbeat") + count("renew") + count("control") + count("usage"),
	};
}

test(
	"the root run's pool counts show one request and one write per worker heartbeat (#4313)",
	async () => {
		const f = await fixture("root", undefined, { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS });
		try {
			await f.finishing();
			const stats = () => f.store.run("root")?.pool?.coordination;
			await waitUntil(async () => (stats()?.requests.heartbeat?.count ?? 0) > 0, f.budget);
			const first = heartbeatTraffic(stats()!);
			await waitUntil(
				async () => heartbeatTraffic(stats()!).heartbeats >= first.heartbeats + OBSERVED_HEARTBEATS,
				f.budget,
			);
			const later = heartbeatTraffic(stats()!);
			const heartbeats = later.heartbeats - first.heartbeats;
			assert.equal(
				later.heartbeatDrivenRequests - first.heartbeatDrivenRequests,
				heartbeats,
				"a running attempt sends nothing but its heartbeat to keep its lease, usage and control current",
			);
			assert.equal(later.heartbeatWrites - first.heartbeatWrites, heartbeats, "one journal write per heartbeat");
			assert.ok(
				heartbeats * LEGACY_REQUESTS_PER_HEARTBEAT > later.heartbeatDrivenRequests - first.heartbeatDrivenRequests,
				"fewer requests than three per tick",
			);
			const snapshot = stats()!;
			assert.equal(snapshot.requests.renew, undefined);
			assert.equal(snapshot.requests.usage, undefined);
			assert.ok(snapshot.since <= Date.now());
			assert.equal(f.pool.coordinationStats()?.since, snapshot.since, "the pool reports the counts it published");
			await f.release();
			assert.equal((await f.running).status, "completed");
		} finally {
			await f.release();
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);

/** Shorter than the lease less a heartbeat, so the worker's next heartbeat after it still lands in time. */
const SHORT_STOP_MS = LEASE_MS - 4 * HEARTBEAT_MS;
/** Well past the lease, so the pool sees the worker as gone. */
const LONG_STOP_MS = 3 * LEASE_MS;

test(
	"a worker stopped within its lease keeps its child, and one stopped past it is replaced (#4313)",
	async () => {
		const f = await fixture("root", undefined, {
			leaseMs: LEASE_MS,
			heartbeatMs: HEARTBEAT_MS,
			runBudgetMs: THREE_WORKERS.waitMs,
		});
		try {
			await f.finishing();
			const queue = await f.ready();
			const [held] = await queue.inspect("root");
			const [pid] = f.pool.workerPids;
			assert.ok(pid !== undefined && held !== undefined);
			process.kill(pid, "SIGSTOP");
			await sleep(SHORT_STOP_MS);
			process.kill(pid, "SIGCONT");
			await sleep(2 * HEARTBEAT_MS);
			const [kept] = await queue.inspect("root");
			assert.equal(kept?.generation, held.generation, "a short stop kept the attempt");
			assert.equal(kept?.state, "leased");
			assert.deepEqual(f.pool.workerPids, [pid], "and the worker");

			process.kill(pid, "SIGSTOP");
			await sleep(LONG_STOP_MS);
			await waitUntil(async () => !f.pool.workerPids.includes(pid), f.budget);
			await waitUntil(async () => (await queue.inspect("root"))[0]!.generation > held.generation, f.budget);
			await f.release();
			assert.equal((await f.running).status, "completed", "the child replayed on the replacement");
		} finally {
			await f.release();
			await f.close();
		}
	},
	THREE_WORKERS.timeoutMs,
);
