import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { listenPoolReady } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/** How long a committed pool write's wake-up may take to reach a host listening on another connection. */
const POOL_WAKE_BOUND_MS = 1_000;
/** How long a write that sent no wake-up is watched for one. */
const QUIET_MS = 300;
const PREFIX = "q5103_";

const { work, boundary } = poolWorkFixture();
const definition = { definition: work.definition, digest: work.digest };

/** A root holding its lease with its pool initialized, and a host's journal on another connection listening for wake-ups. */
async function rootAndHost(scope: PostgresScope) {
	const journal = await SqlRunJournal.open(await scope.open(), { prefix: PREFIX });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, 60_000);
	const host = await SqlRunJournal.open(await scope.open(), { prefix: PREFIX });
	const woken: { readonly root: string | undefined; readonly at: number }[] = [];
	const subscription = listenPoolReady(host, (root) => woken.push({ root, at: performance.now() }));
	assert.ok(subscription, "a journal on Postgres delivers pool wake-ups");
	return {
		pool,
		lease,
		woken,
		/** Waits for the wake-up after `since`, and returns how long after `since` it arrived. */
		async wakeAfter(since: number): Promise<number> {
			const deadline = performance.now() + POOL_WAKE_BOUND_MS;
			for (;;) {
				const wake = woken.find((entry) => entry.at >= since && entry.root !== undefined);
				if (wake !== undefined) {
					assert.equal(wake.root, "root");
					return wake.at - since;
				}
				assert.ok(performance.now() < deadline, `no wake-up within ${POOL_WAKE_BOUND_MS} ms`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		},
		async close() {
			subscription.close();
			await host.close();
			await backend.close();
			await journal.close();
		},
	};
}

/** Waits until the host's listening connection listens, so a wake-up sent next reaches it. */
async function listening(scope: PostgresScope): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (
		(await scope.admin.get(
			"SELECT 1 AS listening FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%pool_ready%'",
			scope.name,
		)) === undefined
	) {
		assert.ok(Date.now() < deadline, "the host never listened");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe.skipIf(postgresSkipReason !== undefined)("worker pool wake-ups on Postgres (#5103)", () => {
	test("enqueue, release and complete each wake a listening host promptly with the root, and a claim sends none (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const f = await rootAndHost(scope);
			try {
				await listening(scope);
				let since = performance.now();
				await f.pool.enqueue(f.lease, work, boundary);
				assert.ok((await f.wakeAfter(since)) < POOL_WAKE_BOUND_MS);

				since = performance.now();
				const first = await f.pool.claim(f.lease, "worker", [definition], 60_000);
				assert.ok(first);
				await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
				assert.equal(f.woken.filter((entry) => entry.at >= since).length, 0, "a claim makes nothing ready");

				since = performance.now();
				assert.equal(await f.pool.releaseExited(f.lease, first), true);
				await f.wakeAfter(since);

				const second = await f.pool.claim(f.lease, "worker", [definition], 60_000);
				assert.ok(second);
				since = performance.now();
				await f.pool.complete(f.lease, second, { runId: work.childRunId, status: "completed", result: {} });
				await f.wakeAfter(since);
			} finally {
				await f.close();
			}
		});
	});

	test("a pool write refused by its fence sends no wake-up (#5103)", async () => {
		await withPostgresDatabase(async (scope) => {
			const f = await rootAndHost(scope);
			try {
				await listening(scope);
				await f.pool.enqueue(f.lease, work, boundary);
				const attempt = await f.pool.claim(f.lease, "worker", [definition], 60_000);
				assert.ok(attempt);
				await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
				const since = performance.now();
				// The first release settles the attempt; the second finds nothing to settle and commits no change.
				assert.equal(await f.pool.releaseExited(f.lease, attempt), true);
				await f.wakeAfter(since);
				const after = performance.now();
				assert.equal(await f.pool.releaseExited(f.lease, attempt), false);
				await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
				assert.equal(f.woken.filter((entry) => entry.at >= after).length, 0);
			} finally {
				await f.close();
			}
		});
	});
});
