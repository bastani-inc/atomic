/**
 * Chaos for the coalesced worker heartbeat (#4313): a slow journal, a skewed journal clock, a full disk and a crowd of
 * other writers. Each keeps the heartbeat's invariants: one heartbeat in flight per worker, no burst of missed beats
 * afterwards, no attempt that lapses while its worker keeps beating, and nothing half-written by a heartbeat that fails.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultWorkerHeartbeatMs } from "../../packages/workflows/src/workers/worker-timing.js";
import {
	assertNoLapse,
	assertRenewedBeforeExpiry,
	coalescedWorker,
	simulatedPool,
	usageAt,
} from "../helpers/pool-heartbeat-simulation.js";

const WORKERS = 200;
const LEASE_MS = 60_000;
const INTERVAL_MS = defaultWorkerHeartbeatMs(LEASE_MS);
const WINDOW_MS = 180_000;
const STEP_MS = 500;
/** Structural cost: hundreds of simulated workers against SQLite over three virtual minutes. */
const CHAOS_SIMULATION_TIMEOUT_MS = 120_000;
/** SQLite's primary result code for a write that needs pages the database cannot have. */
const SQLITE_FULL = 13;

/** The SQLite result code of the first error in `error`'s cause chain that carries one. */
function sqliteErrorCode(error: unknown): number | undefined {
	for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++) {
		const code = (current as Error & { readonly errcode?: unknown }).errcode;
		if (typeof code === "number") return code & 0xff;
		current = current.cause;
	}
	return undefined;
}

test("closing a heartbeat simulation releases its caller-owned SQLite connection (#4313)", async () => {
	const pool = await simulatedPool(1, LEASE_MS);
	await pool.close();
	assert.equal(pool.connection.isOpen, false);
});

test(
	"heartbeats answered two intervals late neither overlap, burst nor let a lease lapse (#4313)",
	async () => {
		const replyDelayMs = 2 * INTERVAL_MS;
		const pool = await simulatedPool(WORKERS, LEASE_MS);
		try {
			const workers = Array.from({ length: WORKERS }, (_, index) =>
				coalescedWorker(pool, index, INTERVAL_MS, replyDelayMs),
			);
			await pool.advance(WINDOW_MS, STEP_MS, async () => {
				await assertNoLapse(pool, workers);
			});
			await Promise.all(workers.map((worker) => worker.stop()));
			const longestGap = assertRenewedBeforeExpiry(pool, workers);
			assert.ok(longestGap <= INTERVAL_MS + replyDelayMs, `${longestGap} ms between renewals`);
			assert.ok(longestGap < LEASE_MS);
			for (const worker of workers) {
				assert.equal(worker.maxInFlight, 1, `worker ${worker.index} had heartbeats in flight at once`);
				assert.ok(
					worker.requests <= Math.ceil(WINDOW_MS / (INTERVAL_MS + replyDelayMs)) + 1,
					`worker ${worker.index} sent ${worker.requests} heartbeats: the late answers left a backlog`,
				);
			}
		} finally {
			await pool.close();
		}
	},
	CHAOS_SIMULATION_TIMEOUT_MS,
);

test(
	"a journal clock that jumps ahead or back never makes a beating worker's lease lapse or shrink (#4313)",
	async () => {
		const jumpAheadMs = LEASE_MS - INTERVAL_MS - STEP_MS - 1_000;
		const pool = await simulatedPool(WORKERS, LEASE_MS);
		try {
			const workers = Array.from({ length: WORKERS }, (_, index) => coalescedWorker(pool, index, INTERVAL_MS));
			let steps = 0;
			await pool.advance(WINDOW_MS, STEP_MS, async () => {
				steps++;
				// One third in, the journal clock jumps ahead; two thirds in, it falls back behind the workers' clock.
				if (steps === WINDOW_MS / STEP_MS / 3) pool.skewMs = jumpAheadMs;
				if (steps === (2 * WINDOW_MS) / STEP_MS / 3) pool.skewMs = -INTERVAL_MS;
				await assertNoLapse(pool, workers);
			});
			await Promise.all(workers.map((worker) => worker.stop()));
			assertRenewedBeforeExpiry(pool, workers);
			for (const worker of workers) {
				let expiresAt = pool.attempts[worker.index]!.expiresAt;
				for (const renewal of worker.renewals) {
					assert.ok(
						renewal.expiresAt >= expiresAt,
						`worker ${worker.index}'s lease shrank when the clock fell back`,
					);
					expiresAt = renewal.expiresAt;
				}
			}
		} finally {
			await pool.close();
		}
	},
	CHAOS_SIMULATION_TIMEOUT_MS,
);

test(
	"a heartbeat refused by a full disk leaves its lease and usage untouched, and the next one succeeds (#4313)",
	async () => {
		const pool = await simulatedPool(4, LEASE_MS);
		try {
			const [attempt] = pool.attempts;
			assert.ok(attempt);
			await pool.advance(10_000, STEP_MS);
			const before = (await pool.inspect()).find((work) => work.id === attempt.id)!;
			const usageBefore = await pool.usage.total("root");
			const pages = Number(pool.connection.prepare("PRAGMA page_count").get()?.page_count);
			pool.connection.exec(`PRAGMA max_page_count = ${pages}`);
			// Enough new usage rows that recording them needs pages the disk no longer has.
			const reports = Array.from({ length: 2_000 }, (_, index) => ({
				key: `stage:full-disk:${index}:${"x".repeat(200)}`,
				usage: usageAt(0, 60_000)[0]!.usage,
			}));
			await assert.rejects(
				pool.queue.heartbeat(pool.lease, attempt, LEASE_MS, pool.usage.recording(pool.lease, attempt, reports)),
				(error: unknown) => sqliteErrorCode(error) === SQLITE_FULL,
			);
			const after = (await pool.inspect()).find((work) => work.id === attempt.id)!;
			assert.deepEqual(after, before, "the renewal rolled back with the usage it was coalesced with");
			assert.deepEqual(
				await pool.usage.total("root"),
				usageBefore,
				"no usage of the refused heartbeat was recorded",
			);
			pool.connection.exec("PRAGMA max_page_count = 1073741823");
			const beat = await pool.queue.heartbeat(
				pool.lease,
				attempt,
				LEASE_MS,
				pool.usage.recording(pool.lease, attempt, usageAt(0, 60_000)),
			);
			assert.ok(beat.work.renewedAt > before.renewedAt, "the next heartbeat renews the attempt");
			assert.deepEqual(beat.control, { state: "running", revision: 0 });
			assert.equal(beat.recorded.input, usageAt(0, 60_000)[0]!.usage.input);
		} finally {
			await pool.close();
		}
	},
	CHAOS_SIMULATION_TIMEOUT_MS,
);

test(
	"heartbeats keep every lease while hundreds of other writes share the journal with them (#4313)",
	async () => {
		const pool = await simulatedPool(WORKERS, LEASE_MS);
		try {
			const workers = Array.from({ length: WORKERS }, (_, index) => coalescedWorker(pool, index, INTERVAL_MS));
			let otherWrites = 0;
			// Every step, each worker's attempt also reports usage on its own and is extended on the way to another
			// request, as a busy coordinator's other traffic does, in the same group commits as the heartbeats.
			const crowd = setInterval(() => {
				for (const worker of workers) {
					otherWrites += 2;
					void pool.track(pool.usage.report(pool.lease, worker.held, usageAt(worker.index, pool.elapsed())));
					void pool.track(pool.queue.extend(pool.lease, worker.held, LEASE_MS));
				}
			}, STEP_MS);
			pool.measuring = true;
			await pool.advance(WINDOW_MS, STEP_MS, async () => {
				await assertNoLapse(pool, workers);
			});
			pool.measuring = false;
			clearInterval(crowd);
			await Promise.all(workers.map((worker) => worker.stop()));
			assertRenewedBeforeExpiry(pool, workers);
			const heartbeats = workers.reduce((sum, worker) => sum + worker.requests, 0);
			assert.equal(heartbeats, WORKERS * (WINDOW_MS / INTERVAL_MS));
			assert.equal(pool.transactions, heartbeats + otherWrites, "every write committed, none was retried or lost");
		} finally {
			await pool.close();
		}
	},
	CHAOS_SIMULATION_TIMEOUT_MS,
);
