import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { observeSqlPoolTransactions, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { RUN_EVENT_TYPES, type RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";

/**
 * A pooled child starts in a fresh worker, and the worker opens the pool's queue and its session store over the journal
 * every host shares (#4768). On a shared libSQL server every write transaction waits its turn for the database's one
 * write lock, and holds it for each of its round trips, so a pool whose tables exist opens with reads alone: the opens'
 * schema probes and their idempotent setup never queue another host's writes, or a fresh client's, behind them.
 */
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A journal in a libSQL database file, which the libSQL adapter opens as it opens a server's. */
async function sharedJournal(): Promise<RunJournal> {
	const directory = makeLibsqlDirectory("pool-open-locks-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const journal = await resolveRunJournal({
		agentDir: join(directory, "agent"),
		journal: { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" },
	});
	cleanups.push(() => journal.close());
	return journal;
}

/** Counts the write transactions and batches of `journal`'s pool from now on. */
function countWrites(journal: RunJournal): () => number {
	let writes = 0;
	observeSqlPoolTransactions(journal, () => {
		writes++;
	});
	return () => writes;
}

test("a worker opens the pool's session store without a write transaction once its tables exist (#4768)", async () => {
	const journal = await sharedJournal();
	// The first open creates the store's tables, under the write lock.
	const first = await openPoolSessions(sqlPoolStorage(journal)!);
	await first.close();

	const writes = countWrites(journal);
	const again = await openPoolSessions(sqlPoolStorage(journal)!);
	try {
		assert.equal(await again.readHeader("no-such-session"), undefined, "the store reads its tables");
	} finally {
		await again.close();
	}
	assert.equal(writes(), 0, "opening and reading the store took the write lock");
});

test("a pool's sessions in a local libSQL journal save no reader-only chat records; in a SQLite journal they do (#5682)", async () => {
	// @libsql/client waits for another process's write lock on the calling thread, even to begin a transaction: a saved
	// diagnostic there would stop a pooled stage's event loop where main writes nothing for it.
	const libsqlSessions = await openPoolSessions(sqlPoolStorage(await sharedJournal())!);
	cleanups.push(() => libsqlSessions.close());
	assert.equal(libsqlSessions.chatRecords, undefined);

	const directory = makeLibsqlDirectory("pool-chat-records-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const sqlite = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	cleanups.push(() => sqlite.close());
	const sqliteSessions = await openPoolSessions(sqlPoolStorage(sqlite)!);
	cleanups.push(() => sqliteSessions.close());
	assert.ok(sqliteSessions.chatRecords);
});

test("a worker opens the pool's queue without a write transaction once its tables exist (#4768)", async () => {
	const journal = await sharedJournal();
	// The first open creates the queue's tables, under the write lock.
	await openSqlPoolQueue(journal);

	const writes = countWrites(journal);
	const again = await openSqlPoolQueue(journal);
	assert.equal(await again.initialized("no-such-root"), false, "the queue reads its tables");
	assert.equal(writes(), 0, "opening and reading the queue took the write lock");
});

test("a queue created before background shipping can ship after reopening (#4768)", async () => {
	const journal = await sharedJournal();
	await openSqlPoolQueue(journal);
	await sqlPoolStorage(journal)!.transaction(async (tx) => {
		await tx.exec("DROP TABLE acme_wf_runs_ship_batches; DROP TABLE acme_wf_runs_ship_watermarks");
	});
	const queue = await openSqlPoolQueue(journal);
	await journal.createRun({ runId: "root", name: "root", cwd: "/repo", createdAt: 1, status: "running" });
	const acquired = await journal.acquire("root", "holder");
	assert.equal(acquired.status, "acquired");
	const lease = acquired.lease;
	await queue.initialize(lease, 60_000);
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(lease, work, boundary);
	const attempt = await queue.claim(lease, "worker", [work], 60_000);
	assert.ok(attempt);
	const checkpoint: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:1`,
		name: "tool",
		argsHash: `${work.scope}:args:1`,
		output: { saved: true },
		completedAt: 1,
		topology: {
			version: 1,
			nodeId: "tool-1",
			parentIds: [],
			ordinal: 1,
			order: 1,
			run: boundary.topology!.boundary!.child,
		},
	};
	await queue.shipBatch(lease, attempt, {
		id: "batch-1",
		host: "host-A",
		events: [
			{
				localSeq: 1,
				key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "tool", checkpoint.checkpointId]),
				payload: JSON.stringify(checkpoint),
			},
		],
	});
	const recorded = [];
	for await (const entry of journal.read("root"))
		if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded && entry.event.payload.kind === "tool")
			recorded.push(entry.event.payload);
	assert.deepEqual(recorded, [checkpoint]);
});

test("a queue created before ready marks gets them when it reopens on a shared libSQL journal (#5230)", async () => {
	const journal = await sharedJournal();
	await openSqlPoolQueue(journal);
	await sqlPoolStorage(journal)!.transaction(async (tx) => {
		await tx.exec(
			"DROP TRIGGER acme_wf_runs_pool_ready_insert; DROP TRIGGER acme_wf_runs_pool_ready_update; DROP TABLE acme_wf_runs_pool_ready",
		);
	});
	const queue = await openSqlPoolQueue(journal);
	await journal.createRun({ runId: "root", name: "root", cwd: "/repo", createdAt: 1, status: "running" });
	const acquired = await journal.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
	const lease = acquired.lease;
	await queue.initialize(lease, 60_000);
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(lease, work, boundary);
	const queued = await queue.readyMark("root");
	assert.ok(queued !== undefined, "queued work is ready");
	const attempt = await queue.claim(lease, "worker", [work], 60_000);
	assert.ok(attempt);
	assert.equal(await queue.releaseUnplaced(lease, attempt), true);
	const released = await queue.readyMark("root");
	assert.ok(released !== undefined);
	assert.notEqual(released, queued, "releasing the work advances the ready mark");
});

test("a host opens the shared pool's registry, fleet, rate buckets and usage without a write transaction once their tables exist (#4768)", async () => {
	const journal = await sharedJournal();
	const queue = await openSqlPoolQueue(journal);
	// The first opens create the tables, under the write lock.
	await SqlSharedPool.open(journal, queue);
	await SqlFleetStore.open(journal);
	await SqlRateBuckets.open(journal);
	await openSqlPoolUsage(journal);

	const writes = countWrites(journal);
	await SqlSharedPool.open(journal, await openSqlPoolQueue(journal));
	await SqlFleetStore.open(journal);
	await SqlRateBuckets.open(journal);
	await openSqlPoolUsage(journal);
	assert.equal(writes(), 0, "opening a store whose tables exist took the write lock");
});
