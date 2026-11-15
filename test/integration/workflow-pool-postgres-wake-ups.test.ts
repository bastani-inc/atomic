import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { listenPoolReady } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** How long a committed pool write's wake-up may take to reach a host listening on another connection. */
const POOL_WAKE_BOUND_MS = 1_000;
/** How long a write that sent no wake-up is watched for one. */
const QUIET_MS = 300;
const PREFIX = "q5103_";
/**
 * How long after a child is queued an idle worker of a shared pool claims it, when the queue's wake-up reaches it. An
 * idle worker without one asks again only after its 500 ms pause, so it claims at a uniformly random point of that.
 */
const WAKE_CLAIM_BOUND_MS = 200;
const SEQUENTIAL_CHILDREN = 6;
/** The root's pool and a worker host's satellite cold-start. */
const SEQUENTIAL_BUDGET = poolTestBudgetMs(2);

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

	test.skipIf(process.platform === "win32")(
		"idle workers of a root and of a worker host claim each child queued after the last within a short bound (#5103)",
		async () => {
			const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
			const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
			const adapter = fileURLToPath(new URL("../../packages/storage-postgres/postgres.js", import.meta.url));
			await withPostgresDatabase(async (database) => {
				const directory = makeTempDirectory("pool-wake-postgres-");
				const deadline = Date.now() + SEQUENTIAL_BUDGET.waitMs;
				const passwordFile = join(directory, "password");
				writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
				const reader = await database.open();
				const env = (name: string) => ({
					...process.env,
					SHARED_POOL_HOST: name,
					SHARED_POOL_AGENT_DIR: join(directory, name, "agent"),
					SHARED_POOL_ADAPTER: adapter,
					SHARED_POOL_URL: database.url,
					SHARED_POOL_PREFIX: PREFIX,
					SHARED_POOL_ROOT: randomUUID(),
					SHARED_POOL_WORK_MS: "50",
					...(postgresTestPassword === undefined
						? {}
						: { SHARED_POOL_TOKEN_FILE: passwordFile, SHARED_POOL_TOKEN_SECRET: "password" }),
				});
				const host = spawnWithinBudget(
					[process.execPath, hostFixture, directory, "2"],
					{ cwd: directory, stdout: "ignore", env: env("B") },
					deadline,
				);
				try {
					while (!existsSync(join(directory, "host-ready-B"))) {
						assert.ok(Date.now() < deadline, "host B never started");
						await sleep(50);
					}
					// Each child's claim, from its first attempt's row before any heartbeat renews it: both on the database's clock.
					const claims = new Map<string, number>();
					let watching = true;
					const watcher = (async () => {
						while (watching) {
							const rows = await reader
								.all<{ id: string; renewed_at: number; ready_at: number }>(
									`SELECT id, renewed_at, ready_at FROM ${PREFIX}wf_runs_work WHERE state != 'ready' AND generation = 1`,
								)
								.catch(() => []);
							for (const row of rows)
								if (!claims.has(row.id)) claims.set(row.id, Number(row.renewed_at) - Number(row.ready_at));
							await sleep(10);
						}
					})();
					const root = spawnWithinBudget(
						[process.execPath, rootFixture, "start", directory, String(SEQUENTIAL_CHILDREN), "1", "sequential"],
						{ cwd: directory, stdout: "ignore", env: env("A") },
						deadline,
					);
					await expectExitedCleanly(root);
					watching = false;
					await watcher;
					const outcome = await readJson<{ status: string; children: { status: string }[] }>(
						join(directory, "outcome-start.json"),
					);
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
					assert.equal(outcome.children.length, SEQUENTIAL_CHILDREN);
					const latencies = [...claims.values()];
					assert.equal(latencies.length, SEQUENTIAL_CHILDREN, "every child was claimed once");
					// The first child may wait for the workers to start; every later one finds them idle.
					const prompt = latencies.filter((latency) => latency < WAKE_CLAIM_BOUND_MS);
					assert.ok(
						prompt.length >= SEQUENTIAL_CHILDREN - 1,
						`claims took ${latencies.join(", ")} ms; all but one should take under ${WAKE_CLAIM_BOUND_MS} ms`,
					);
					host.process.kill("SIGTERM");
					await expectExitedCleanly(host);
				} finally {
					if (host.process.exitCode === null) host.process.kill("SIGKILL");
					removeTempDirectory(directory);
				}
			});
		},
		SEQUENTIAL_BUDGET.timeoutMs,
	);
});
